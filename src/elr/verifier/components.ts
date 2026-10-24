// Connected-component counting for the ELR verifier element checks (spec §2 D4, §3, §9 M2).
//
// The proposal (docs/elr-canvas-proposal.md, experiment 1) adds "connected components per element" to
// the boundary-F reward so a broken drawing (extra disjoint blobs) is caught even when the outline it
// hits scores well. Counting is deterministic and pure JS, with no scanning order dependence beyond
// the fixed raster order, so the same fixture always yields the same number.

import type { BinaryMask } from "./mask.ts";

export type Connectivity = 4 | 8;

const NEIGHBOURS_4: readonly (readonly [number, number])[] = [
	[-1, 0],
	[1, 0],
	[0, -1],
	[0, 1],
];

const NEIGHBOURS_8: readonly (readonly [number, number])[] = [
	[-1, -1],
	[0, -1],
	[1, -1],
	[-1, 0],
	[1, 0],
	[-1, 1],
	[0, 1],
	[1, 1],
];

/**
 * Number of connected components of ink pixels. 8-connectivity by default, so a diagonal stroke is
 * one component rather than two. Iterative (explicit stack, no recursion), O(width*height), and it
 * never mutates the input mask.
 */
export function countComponents(mask: BinaryMask, connectivity: Connectivity = 8): number {
	if (connectivity !== 4 && connectivity !== 8) {
		throw new Error(`connectivity must be 4 or 8, got ${connectivity}`);
	}
	const { width, height, data } = mask;
	const neighbours = connectivity === 4 ? NEIGHBOURS_4 : NEIGHBOURS_8;
	const visited = new Uint8Array(data.length);
	// Every pixel is pushed at most once, so data.length is a safe bound on stack depth.
	const stack = new Int32Array(data.length);
	let count = 0;

	for (let start = 0; start < data.length; start++) {
		if (data[start] === 0 || visited[start] !== 0) continue;
		count++;
		let top = 0;
		stack[top++] = start;
		visited[start] = 1;
		while (top > 0) {
			const i = stack[--top]!;
			const x = i % width;
			const y = (i / width) | 0;
			for (const [dx, dy] of neighbours) {
				const nx = x + dx;
				const ny = y + dy;
				if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
				const j = ny * width + nx;
				if (data[j] !== 0 && visited[j] === 0) {
					visited[j] = 1;
					stack[top++] = j;
				}
			}
		}
	}
	return count;
}
