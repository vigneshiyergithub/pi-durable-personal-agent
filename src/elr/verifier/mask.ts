// Binary masks and boundary extraction for the ELR verifier (spec §3, D4).
//
// A mask is a width x height grid of 0/1 bytes. Coverage rasters from src/elr/raster.ts are
// 0..255; maskFromCoverage thresholds them. "Boundary" is the set of inked pixels that touch
// background (4-neighbourhood), with out-of-bounds counting as background so the canvas edge is
// part of the boundary for a fully inked canvas.

export type BinaryMask = {
	width: number;
	height: number;
	/** One byte per pixel: 1 = ink, 0 = background. */
	data: Uint8Array;
};

export function maskFromCoverage(coverage: Uint8Array, width: number, height: number, threshold = 127): BinaryMask {
	if (coverage.length !== width * height) {
		throw new Error(`coverage length ${coverage.length} does not match ${width}x${height}`);
	}
	const data = new Uint8Array(width * height);
	for (let i = 0; i < data.length; i++) {
		data[i] = coverage[i]! >= threshold ? 1 : 0;
	}
	return { width, height, data };
}

/** Number of set (ink/boundary) pixels in a byte grid. */
export function countSet(grid: Uint8Array): number {
	let n = 0;
	for (let i = 0; i < grid.length; i++) if (grid[i] !== 0) n++;
	return n;
}

/** Pixels that are inked and have at least one 4-neighbour that is not; edges of the canvas count as outside. */
export function boundaryOf(mask: BinaryMask): Uint8Array {
	const { width, height, data } = mask;
	const boundary = new Uint8Array(width * height);
	for (let y = 0; y < height; y++) {
		const row = y * width;
		for (let x = 0; x < width; x++) {
			const i = row + x;
			if (data[i] === 0) continue;
			const up = y === 0 || data[i - width] === 0;
			const down = y === height - 1 || data[i + width] === 0;
			const left = x === 0 || data[i - 1] === 0;
			const right = x === width - 1 || data[i + 1] === 0;
			if (up || down || left || right) boundary[i] = 1;
		}
	}
	return boundary;
}
