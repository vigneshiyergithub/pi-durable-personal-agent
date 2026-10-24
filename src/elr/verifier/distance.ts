// Linear-time (exact) Euclidean distance transform for the ELR verifier.
//
// squaredDistanceTransform returns, for every pixel, the squared Euclidean distance to the nearest
// "feature" (nonzero) pixel. It uses the Felzenszwalb & Huttenlocher two-pass algorithm: a 1D lower
// envelope of parabolas along each row, then the same along each column. Each 1D transform is O(n)
// (the inner loop is amortised linear), so the whole transform is O(width*height), not the O(n^2)
// per-pixel brute force the proposal calls out (docs/elr-canvas-proposal.md, experiment 1).
//
// No feature pixels at all yields Infinity everywhere.

// Sentinel for "no feature found yet". Chosen far above any real squared distance (max is about
// 2*256^2 = 131072) but comfortably inside float64's exact-integer range, so the parabolic
// intersections below stay exact.
const FAR = 1e12;

// One-dimensional squared distance transform over a row/column of length n. v/z are scratch buffers
// of length n+1 and are reused across calls.
function dt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
	let k = 0;
	v[0] = 0;
	z[0] = -Infinity;
	z[1] = Infinity;
	for (let q = 1; q < n; q++) {
		let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
		while (s <= z[k]!) {
			k--;
			s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
		}
		k++;
		v[k] = q;
		z[k] = s;
		z[k + 1] = Infinity;
	}
	k = 0;
	for (let q = 0; q < n; q++) {
		while (z[k + 1]! < q) k++;
		const dq = q - v[k]!;
		d[q] = dq * dq + f[v[k]!]!;
	}
}

export function squaredDistanceTransform(mask: Uint8Array, width: number, height: number): Float64Array {
	if (width <= 0 || height <= 0) throw new Error("width and height must be positive");
	if (mask.length !== width * height) {
		throw new Error(`mask length ${mask.length} does not match ${width}x${height}`);
	}
	const n = width * height;
	const maxDim = width > height ? width : height;
	const f = new Float64Array(maxDim);
	const d = new Float64Array(maxDim);
	const v = new Int32Array(maxDim + 1);
	const z = new Float64Array(maxDim + 1);

	const out = new Float64Array(n);
	for (let i = 0; i < n; i++) out[i] = mask[i] !== 0 ? 0 : FAR;

	for (let y = 0; y < height; y++) {
		const base = y * width;
		for (let x = 0; x < width; x++) f[x] = out[base + x]!;
		dt1d(f, width, d, v, z);
		for (let x = 0; x < width; x++) out[base + x] = d[x]!;
	}
	for (let x = 0; x < width; x++) {
		for (let y = 0; y < height; y++) f[y] = out[y * width + x]!;
		dt1d(f, height, d, v, z);
		for (let y = 0; y < height; y++) out[y * width + x] = d[y]!;
	}

	for (let i = 0; i < n; i++) if (out[i]! >= FAR / 2) out[i] = Infinity;
	return out;
}
