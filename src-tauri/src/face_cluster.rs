//! Constrained average-linkage agglomerative clustering for face embeddings.
//!
//! Exact greedy semantics (always merge the most similar pair, stop below `threshold`) but
//! ~O(m²) instead of O(m³): each cluster caches its best neighbour, and after a merge only
//! rows whose cached neighbour changed are rescanned. Similarities between clusters are
//! kept in a condensed triangle and updated with the Lance-Williams average rule.
//!
//! Constraints:
//! - must-link: callers pass pre-grouped `initial` clusters (e.g. faces the user confirmed).
//! - cannot-link: `cannot_link(i, j)` over initial clusters becomes -inf similarity. Because
//!   the weighted average of -inf with anything is -inf, the constraint survives every merge.

use rayon::prelude::*;

struct Tri {
    m: usize,
    data: Vec<f32>,
}

impl Tri {
    #[inline]
    fn idx(&self, i: usize, j: usize) -> usize {
        let (i, j) = if i < j { (i, j) } else { (j, i) };
        i * self.m - i * (i + 1) / 2 + (j - i - 1)
    }
    #[inline]
    fn get(&self, i: usize, j: usize) -> f32 {
        self.data[self.idx(i, j)]
    }
    #[inline]
    fn set(&mut self, i: usize, j: usize, v: f32) {
        let k = self.idx(i, j);
        self.data[k] = v;
    }
}

#[inline]
fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Clusters `embeddings` (L2-normalized). `initial` must partition `0..embeddings.len()`.
/// Returns clusters as lists of embedding indices, largest first.
///
/// Phase 1 merges by average pairwise similarity (`threshold`): conservative, never chains strangers.
/// Phase 2 merges clusters whose *centroids* agree (`centroid_threshold`). A person photographed in
/// two distinct conditions (pose, glasses, lighting, age) forms two tight sub-clusters whose average
/// cross-pair similarity sits below `threshold`, while their centroids - noise averaged out - still
/// match strongly. Cannot-links carry over (their -inf entries are kept).
///
/// But two *different* look-alike people photographed in identical conditions (same studio, light,
/// pose) also have centroids that agree. What separates the cases is a bridge: the same person
/// always has at least one near-identical face pair across the two sub-clusters, different people
/// don't. So phase 2 also requires the best cross pair to reach `bridge`.
pub fn cluster(
    embeddings: &[&[f32]],
    initial: Vec<Vec<usize>>,
    cannot_link: &(dyn Fn(usize, usize) -> bool + Sync),
    threshold: f32,
    centroid_threshold: f32,
    bridge: f32,
) -> Vec<Vec<usize>> {
    let m = initial.len();
    if m <= 1 {
        return initial;
    }

    // Average (for linkage) and maximum (for bridging) pairwise similarity between initial clusters.
    let rows: Vec<Vec<(f32, f32)>> = (0..m)
        .into_par_iter()
        .map(|i| {
            ((i + 1)..m)
                .map(|j| {
                    if cannot_link(i, j) {
                        return (f32::NEG_INFINITY, f32::NEG_INFINITY);
                    }
                    let (mut sum, mut max) = (0f32, f32::NEG_INFINITY);
                    for &a in &initial[i] {
                        for &b in &initial[j] {
                            let d = dot(embeddings[a], embeddings[b]);
                            sum += d;
                            max = max.max(d);
                        }
                    }
                    (sum / (initial[i].len() * initial[j].len()) as f32, max)
                })
                .collect()
        })
        .collect();
    let flat: Vec<(f32, f32)> = rows.into_iter().flatten().collect();
    let mut sim = Tri { m, data: flat.iter().map(|x| x.0).collect() };
    let mut maxs = Tri { m, data: flat.iter().map(|x| x.1).collect() };

    let mut members = initial;
    let mut active = vec![true; m];
    let mut size: Vec<f32> = members.iter().map(|c| c.len() as f32).collect();

    let best_of = |sim: &Tri, active: &[bool], i: usize| -> (usize, f32) {
        let mut best = (usize::MAX, f32::NEG_INFINITY);
        for k in 0..m {
            if k != i && active[k] {
                let s = sim.get(i, k);
                if s > best.1 {
                    best = (k, s);
                }
            }
        }
        best
    };
    let mut best: Vec<(usize, f32)> = (0..m).map(|i| best_of(&sim, &active, i)).collect();

    loop {
        let mut top = (usize::MAX, f32::NEG_INFINITY);
        for i in 0..m {
            if active[i] && best[i].1 > top.1 {
                top = (i, best[i].1);
            }
        }
        let (i, s) = top;
        if i == usize::MAX || s < threshold {
            break;
        }
        let j = best[i].0;

        // Merge j into i.
        let (ni, nj) = (size[i], size[j]);
        for k in 0..m {
            if active[k] && k != i && k != j {
                let v = (ni * sim.get(i, k) + nj * sim.get(j, k)) / (ni + nj);
                sim.set(i, k, v);
                let mx = maxs.get(i, k).max(maxs.get(j, k));
                maxs.set(i, k, mx);
            }
        }
        active[j] = false;
        size[i] += nj;
        let moved = std::mem::take(&mut members[j]);
        members[i].extend(moved);

        best[i] = best_of(&sim, &active, i);
        for k in 0..m {
            if !active[k] || k == i {
                continue;
            }
            if best[k].0 == i || best[k].0 == j {
                best[k] = best_of(&sim, &active, k);
            } else {
                let v = sim.get(i, k);
                if v > best[k].1 {
                    best[k] = (i, v);
                }
            }
        }
    }

    // ---- phase 2: centroid merging over the surviving clusters ----
    let dim = embeddings.first().map(|e| e.len()).unwrap_or(0);
    let mut sums: Vec<Vec<f32>> = vec![Vec::new(); m];
    for i in (0..m).filter(|&i| active[i]) {
        let mut sum = vec![0f32; dim];
        for &f in &members[i] {
            sum.iter_mut().zip(embeddings[f]).for_each(|(a, b)| *a += b);
        }
        sums[i] = sum;
    }
    // Guard against centroid drift: the average cross-pair similarity must still be respectable,
    // otherwise a growing cluster's "average face" centroid starts absorbing look-alikes.
    let avg_floor = threshold - 0.08;
    let csim = |sums: &[Vec<f32>], sim: &Tri, maxs: &Tri, i: usize, k: usize| -> f32 {
        if sim.get(i, k) < avg_floor || maxs.get(i, k) < bridge {
            return f32::NEG_INFINITY;
        }
        let (a, b) = (&sums[i], &sums[k]);
        let n = (dot(a, a) * dot(b, b)).sqrt().max(1e-9);
        dot(a, b) / n
    };
    let cbest_of = |sums: &[Vec<f32>], sim: &Tri, maxs: &Tri, active: &[bool], i: usize| -> (usize, f32) {
        let mut best = (usize::MAX, f32::NEG_INFINITY);
        for k in 0..m {
            if k != i && active[k] {
                let s = csim(sums, sim, maxs, i, k);
                if s > best.1 {
                    best = (k, s);
                }
            }
        }
        best
    };
    let mut cbest: Vec<(usize, f32)> =
        (0..m).map(|i| if active[i] { cbest_of(&sums, &sim, &maxs, &active, i) } else { (usize::MAX, f32::NEG_INFINITY) }).collect();
    loop {
        let mut top = (usize::MAX, f32::NEG_INFINITY);
        for i in 0..m {
            if active[i] && cbest[i].1 > top.1 {
                top = (i, cbest[i].1);
            }
        }
        let (i, s) = top;
        if i == usize::MAX || s < centroid_threshold {
            break;
        }
        let j = cbest[i].0;
        // Keep the average-linkage row consistent so cannot-links (-inf) propagate.
        let (ni, nj) = (size[i], size[j]);
        for k in 0..m {
            if active[k] && k != i && k != j {
                let v = (ni * sim.get(i, k) + nj * sim.get(j, k)) / (ni + nj);
                sim.set(i, k, v);
                let mx = maxs.get(i, k).max(maxs.get(j, k));
                maxs.set(i, k, mx);
            }
        }
        active[j] = false;
        size[i] += nj;
        let sj = std::mem::take(&mut sums[j]);
        sums[i].iter_mut().zip(&sj).for_each(|(a, b)| *a += b);
        let moved = std::mem::take(&mut members[j]);
        members[i].extend(moved);
        cbest[i] = cbest_of(&sums, &sim, &maxs, &active, i);
        for k in 0..m {
            if !active[k] || k == i {
                continue;
            }
            if cbest[k].0 == i || cbest[k].0 == j {
                cbest[k] = cbest_of(&sums, &sim, &maxs, &active, k);
            } else {
                let v = csim(&sums, &sim, &maxs, i, k);
                if v > cbest[k].1 {
                    cbest[k] = (i, v);
                }
            }
        }
    }

    let mut out: Vec<Vec<usize>> = members
        .into_iter()
        .zip(active)
        .filter_map(|(c, a)| if a { Some(c) } else { None })
        .collect();
    out.sort_by(|a, b| b.len().cmp(&a.len()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(v: &[f32]) -> Vec<f32> {
        let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        v.iter().map(|x| x / n).collect()
    }

    #[test]
    fn separates_identities_and_respects_constraints() {
        let e = vec![
            unit(&[1.0, 0.1, 0.0]),
            unit(&[0.9, 0.2, 0.0]),
            unit(&[1.0, 0.0, 0.1]),
            unit(&[0.0, 1.0, 0.1]),
            unit(&[0.1, 0.9, 0.0]),
        ];
        let refs: Vec<&[f32]> = e.iter().map(|v| v.as_slice()).collect();
        let init: Vec<Vec<usize>> = (0..e.len()).map(|i| vec![i]).collect();
        let c = cluster(&refs, init.clone(), &|_, _| false, 0.5, f32::INFINITY, 0.0);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].len(), 3);

        // Faces 0 and 2 came from the same photo: they may never share a cluster.
        let c = cluster(&refs, init, &|a, b| (a.min(b), a.max(b)) == (0, 2), 0.5, 0.0, 0.0);
        assert!(c.iter().all(|cl| !(cl.contains(&0) && cl.contains(&2))));
    }

    #[test]
    fn centroid_phase_rejoins_split_person() {
        // One person in two conditions: identity (dim 0) + condition (1 or 2) + per-photo noise (3..6).
        // Cross-condition pairs average ~0.37 (< 0.38) but the sub-cluster centroids agree at ~0.48.
        let face = |cond: usize, noise: usize| {
            let mut v = vec![0f32; 8];
            v[0] = 1.0;
            v[cond] = 0.7;
            v[noise] = 1.1;
            unit(&v)
        };
        let mut other = vec![0f32; 8];
        other[7] = 1.0;
        let e = vec![face(1, 3), face(1, 4), face(2, 5), face(2, 6), other];
        let refs: Vec<&[f32]> = e.iter().map(|v| v.as_slice()).collect();
        let init: Vec<Vec<usize>> = (0..e.len()).map(|i| vec![i]).collect();
        assert_eq!(cluster(&refs, init.clone(), &|_, _| false, 0.38, f32::INFINITY, 0.0).len(), 3);
        let c = cluster(&refs, init, &|_, _| false, 0.38, 0.45, 0.0);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].len(), 4);
    }

    #[test]
    fn look_alikes_need_a_bridge_pair_to_merge() {
        // Same geometry as above: centroids agree (~0.48) but the best cross pair is only ~0.37,
        // like two different people shot in one studio session.
        let face = |cond: usize, noise: usize, w: f32| {
            let mut v = vec![0f32; 9];
            v[0] = 1.0;
            v[cond] = 0.7;
            v[noise] = w;
            unit(&v)
        };
        let e = vec![face(1, 3, 1.1), face(1, 4, 1.1), face(2, 5, 1.1), face(2, 6, 1.1)];
        let refs: Vec<&[f32]> = e.iter().map(|v| v.as_slice()).collect();
        let init: Vec<Vec<usize>> = (0..e.len()).map(|i| vec![i]).collect();
        assert_eq!(cluster(&refs, init.clone(), &|_, _| false, 0.38, 0.45, 0.60).len(), 2, "no bridge: stay apart");

        // The same person in two conditions has a near-identical pose pair across the groups.
        let mut bridged = e.clone();
        let mut b = vec![0f32; 9];
        b[0] = 1.0;
        b[1] = 0.45;
        b[2] = 0.45;
        b[8] = 0.3;
        bridged.push(unit(&b));
        let refs: Vec<&[f32]> = bridged.iter().map(|v| v.as_slice()).collect();
        let init: Vec<Vec<usize>> = (0..bridged.len()).map(|i| vec![i]).collect();
        assert_eq!(cluster(&refs, init, &|_, _| false, 0.38, 0.45, 0.60).len(), 1, "bridged: one person");
    }

    #[test]
    fn must_link_initial_groups_stay_together() {
        let e = vec![unit(&[1.0, 0.0]), unit(&[0.0, 1.0])];
        let refs: Vec<&[f32]> = e.iter().map(|v| v.as_slice()).collect();
        let c = cluster(&refs, vec![vec![0, 1]], &|_, _| false, 0.9, 0.9, 0.0);
        assert_eq!(c, vec![vec![0, 1]]);
    }
}
