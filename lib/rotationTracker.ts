export interface RotationConfig {
  targetAngleDeg: number;
  toleranceDeg: number;
  direction: 'cw' | 'ccw';
  timeoutMs: number;
}

export interface RotationState {
  accumulatedAngle: number;
  phase: 'waiting' | 'rotating' | 'complete' | 'failed';
  directionCorrect: boolean;
  message: string;
}

export interface FeaturePoint {
  x: number;
  y: number;
  prevX: number;
  prevY: number;
}

export class RotationTracker {
  private config: RotationConfig;
  private prevFrame: ImageData | null = null;
  private prevPoints: Array<{ x: number; y: number }> = [];
  private accumulatedAngle = 0;
  private state: RotationState;

  constructor(config?: Partial<RotationConfig>) {
    const dir = config?.direction ?? (Math.random() > 0.5 ? 'cw' : 'ccw');
    this.config = {
      targetAngleDeg: config?.targetAngleDeg ?? 30,
      toleranceDeg: config?.toleranceDeg ?? 10,
      direction: dir,
      timeoutMs: config?.timeoutMs ?? 5000,
    };
    this.state = this.initialState();
  }

  private initialState(): RotationState {
    return {
      accumulatedAngle: 0,
      phase: 'waiting',
      directionCorrect: true,
      message: 'waiting',
    };
  }

  track(frame: ImageData): RotationState {
    if (this.state.phase === 'complete' || this.state.phase === 'failed') {
      return { ...this.state };
    }

    if (!this.prevFrame) {
      this.prevFrame = new ImageData(
        new Uint8ClampedArray(frame.data),
        frame.width,
        frame.height
      );
      this.prevPoints = this.detectCorners(frame);
      if (this.prevPoints.length < 4) {
        this.state = {
          accumulatedAngle: 0,
          phase: 'failed',
          directionCorrect: true,
          message: 'not enough features',
        };
        return { ...this.state };
      }
      this.state = {
        accumulatedAngle: 0,
        phase: 'rotating',
        directionCorrect: true,
        message: 'rotating',
      };
      return { ...this.state };
    }

    const currPoints = this.trackPoints(this.prevFrame, frame, this.prevPoints);
    if (currPoints.length < 4) {
      this.state = {
        accumulatedAngle: this.accumulatedAngle,
        phase: 'failed',
        directionCorrect: this.state.directionCorrect,
        message: 'lost tracking',
      };
      return { ...this.state };
    }

    const centroid = this.computeCentroid(this.prevPoints);
    let totalAngle = 0;
    let validPairs = 0;

    for (let i = 0; i < currPoints.length; i++) {
      const prevP = this.prevPoints[i];
      const currP = currPoints[i];
      const prevVx = prevP.x - centroid.x;
      const prevVy = prevP.y - centroid.y;
      const currVx = currP.x - centroid.x;
      const currVy = currP.y - centroid.y;
      const prevDist = Math.hypot(prevVx, prevVy);
      const currDist = Math.hypot(currVx, currVy);
      if (prevDist < 2 || currDist < 2) continue;
      const dot = prevVx * currVx + prevVy * currVy;
      const cross = prevVx * currVy - prevVy * currVx;
      totalAngle += Math.atan2(cross, dot);
      validPairs++;
    }

    if (validPairs < 3) {
      this.state = {
        accumulatedAngle: this.accumulatedAngle,
        phase: 'failed',
        directionCorrect: this.state.directionCorrect,
        message: 'insufficient motion',
      };
      return { ...this.state };
    }

    const avgAngleRad = totalAngle / validPairs;
    const avgAngleDeg = (avgAngleRad * 180) / Math.PI;

    const positiveAngle =
      this.config.direction === 'cw'
        ? Math.max(0, avgAngleDeg)
        : Math.max(0, -avgAngleDeg);

    this.accumulatedAngle += positiveAngle;

    const isCorrectDirection =
      this.config.direction === 'cw' ? avgAngleDeg >= 0 : avgAngleDeg <= 0;

    this.state = {
      accumulatedAngle: this.accumulatedAngle,
      phase: 'rotating',
      directionCorrect: isCorrectDirection,
      message: isCorrectDirection ? 'rotating' : 'wrong direction',
    };

    if (this.accumulatedAngle >= this.config.targetAngleDeg - this.config.toleranceDeg / 2) {
      this.state = {
        accumulatedAngle: this.accumulatedAngle,
        phase: 'complete',
        directionCorrect: true,
        message: 'complete',
      };
      return { ...this.state };
    }

    this.prevFrame = new ImageData(
      new Uint8ClampedArray(frame.data),
      frame.width,
      frame.height
    );
    this.prevPoints = currPoints;

    return { ...this.state };
  }

  private detectCorners(frame: ImageData): Array<{ x: number; y: number }> {
    const { data, width, height } = frame;
    const corners: Array<{ score: number; x: number; y: number }> = [];
    const gridStep = 8;

    for (let y = 6; y < height - 6; y += gridStep) {
      for (let x = 6; x < width - 6; x += gridStep) {
        let ix2 = 0;
        let iy2 = 0;
        let ixy = 0;
        let count = 0;

        for (let dy = -4; dy <= 4; dy++) {
          for (let dx = -4; dx <= 4; dx++) {
            const px = x + dx;
            const py = y + dy;
            if (px <= 0 || px >= width - 1 || py <= 0 || py >= height - 1) continue;
            const gx =
              this.grayscale(data, (py * width + (px + 1)) * 4) -
              this.grayscale(data, (py * width + (px - 1)) * 4);
            const gy =
              this.grayscale(data, ((py + 1) * width + px) * 4) -
              this.grayscale(data, ((py - 1) * width + px) * 4);
            ix2 += gx * gx;
            iy2 += gy * gy;
            ixy += gx * gy;
            count++;
          }
        }

        if (count < 5) continue;
        ix2 /= count;
        iy2 /= count;
        ixy /= count;

        const det = ix2 * iy2 - ixy * ixy;
        const trace = ix2 + iy2;
        const score = det - 0.04 * trace * trace;

        if (score > 100) {
          corners.push({ score, x, y });
        }
      }
    }

    corners.sort((a, b) => b.score - a.score);
    const selected: Array<{ x: number; y: number }> = [];
    const minDist = 14;
    const maxPoints = 80;

    for (const c of corners) {
      if (selected.length >= maxPoints) break;
      const tooClose = selected.some((s) => Math.hypot(s.x - c.x, s.y - c.y) < minDist);
      if (!tooClose) {
        selected.push({ x: c.x, y: c.y });
      }
    }

    return selected;
  }

  private grayscale(data: Uint8ClampedArray, idx: number): number {
    return 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
  }

  private trackPoints(
    prevFrame: ImageData,
    currFrame: ImageData,
    prevPoints: Array<{ x: number; y: number }>
  ): Array<{ x: number; y: number }> {
    const blockHalf = 4;
    const searchRadius = 12;
    const tracked: Array<{ x: number; y: number }> = [];

    for (const p of prevPoints) {
      let bestSSD = Infinity;
      let bestX = p.x;
      let bestY = p.y;

      for (let dy = -searchRadius; dy <= searchRadius; dy++) {
        for (let dx = -searchRadius; dx <= searchRadius; dx++) {
          const sx = p.x + dx;
          const sy = p.y + dy;
          if (
            sx - blockHalf < 0 ||
            sx + blockHalf >= currFrame.width ||
            sy - blockHalf < 0 ||
            sy + blockHalf >= currFrame.height
          ) {
            continue;
          }

          let ssd = 0;
          for (let by = -blockHalf; by <= blockHalf; by++) {
            for (let bx = -blockHalf; bx <= blockHalf; bx++) {
              const prevIdx = ((p.y + by) * prevFrame.width + (p.x + bx)) * 4;
              const currIdx = ((sy + by) * currFrame.width + (sx + bx)) * 4;
              const diff = this.grayscale(prevFrame.data, prevIdx) - this.grayscale(currFrame.data, currIdx);
              ssd += diff * diff;
            }
          }

          if (ssd < bestSSD) {
            bestSSD = ssd;
            bestX = sx;
            bestY = sy;
          }
        }
      }

      tracked.push({ x: bestX, y: bestY });
    }

    return tracked;
  }

  private computeCentroid(points: Array<{ x: number; y: number }>): { x: number; y: number } {
    let sx = 0;
    let sy = 0;
    for (const p of points) {
      sx += p.x;
      sy += p.y;
    }
    return { x: sx / points.length, y: sy / points.length };
  }

  start(): void {
    this.prevFrame = null;
    this.prevPoints = [];
    this.accumulatedAngle = 0;
    this.state = this.initialState();
  }

  reset(): void {
    this.start();
  }

  getState(): RotationState {
    return { ...this.state };
  }
}
