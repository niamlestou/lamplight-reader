/* Pixel-heavy perspective sampling runs off the UI thread. */
'use strict';

function solveLinear8(A, b) {
  const matrix = A.map((row, index) => row.concat(b[index]));
  for (let column = 0; column < 8; column++) {
    let pivotRow = column;
    for (let row = column + 1; row < 8; row++) if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivotRow][column])) pivotRow = row;
    [matrix[column], matrix[pivotRow]] = [matrix[pivotRow], matrix[column]];
    const pivot = matrix[column][column] || 1e-9;
    for (let cell = column; cell <= 8; cell++) matrix[column][cell] /= pivot;
    for (let row = 0; row < 8; row++) if (row !== column) {
      const factor = matrix[row][column];
      for (let cell = column; cell <= 8; cell++) matrix[row][cell] -= factor * matrix[column][cell];
    }
  }
  return matrix.map(row => row[8]);
}

function homography(width, height, corners) {
  const source = [[0, 0], [width, 0], [width, height], [0, height]], A = [], b = [];
  for (let index = 0; index < 4; index++) {
    const [x, y] = source[index], [X, Y] = corners[index];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
  }
  return solveLinear8(A, b);
}

self.onmessage = event => {
  const { id, source, sourceWidth: sw, sourceHeight: sh, corners, output } = event.data;
  const input = new Uint8ClampedArray(source), width = output.width, height = output.height;
  const pixels = new Uint8ClampedArray(width * height * 4), h = homography(width, height, corners);
  for (let y = 0, di = 0; y < height; y++) {
    for (let x = 0; x < width; x++, di += 4) {
      const denominator = h[6] * x + h[7] * y + 1;
      const sx = (h[0] * x + h[1] * y + h[2]) / denominator;
      const sy = (h[3] * x + h[4] * y + h[5]) / denominator;
      if (sx < 0 || sx >= sw - 1 || sy < 0 || sy >= sh - 1) {
        pixels[di] = pixels[di + 1] = pixels[di + 2] = pixels[di + 3] = 255;
        continue;
      }
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
      const base = (y0 * sw + x0) * 4, right = base + 4, below = base + sw * 4, belowRight = below + 4;
      // Unrolling RGBA avoids an inner function call and keeps the worker cache-friendly.
      for (let channel = 0; channel < 4; channel++) {
        const top = input[base + channel] + (input[right + channel] - input[base + channel]) * fx;
        const bottom = input[below + channel] + (input[belowRight + channel] - input[below + channel]) * fx;
        pixels[di + channel] = top + (bottom - top) * fy;
      }
    }
  }
  self.postMessage({ id, width, height, pixels: pixels.buffer }, [pixels.buffer]);
};
