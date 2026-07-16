/**
 * MorphDraw - 数学・幾何学ヘルパー
 */
const MDMath = {
    KAPPA: 0.552284749831,
    PI2: Math.PI * 2,

    generators: {
        arc: (params) => {
            const x = params.x;
            const y = params.y;
            const r = params.r;
            const a = params.a;
            const i = params.i;

            const initialStartAngle = (i * Math.PI) / 2;
            const initialEndAngle = ((i + 1) * Math.PI) / 2;
            const startAngle = initialStartAngle + a;
            const endAngle = initialEndAngle + a;

            const p0 = { x: x + Math.cos(startAngle) * r, y: y + Math.sin(startAngle) * r };
            const p3 = { x: x + Math.cos(endAngle) * r, y: y + Math.sin(endAngle) * r };
            const p1 = {
                x: p0.x - Math.sin(startAngle) * r * MDMath.KAPPA,
                y: p0.y + Math.cos(startAngle) * r * MDMath.KAPPA
            };
            const p2 = {
                x: p3.x + Math.sin(endAngle) * r * MDMath.KAPPA,
                y: p3.y - Math.cos(endAngle) * r * MDMath.KAPPA
            };
            return [{ v: p0 }, { v: p1 }, { v: p2 }, { v: p3 }];
        },
        connector: (state, params) => { //// ここも検討中。
            const { src1, src2, d1, d2 } = params;
            const bez1 = state.beziers[src1.bezierId];
            const bez2 = state.beziers[src2.bezierId];
            if (!bez1 || !bez2) return [];

            const p0 = MDMath.getPoint(bez1, src1.t);
            const p3 = MDMath.getPoint(bez2, src2.t);
            const tan1 = MDMath.getTangent(bez1, src1.t);
            const tan2 = MDMath.getTangent(bez2, src2.t);

            const p1 = { x: p0.x + tan1.dx * d1, y: p0.y + tan1.dy * d1 };
            const p2 = { x: p3.x - tan2.dx * d2, y: p3.y - tan2.dy * d2 };

            return [{ v: p0 }, { v: p1 }, { v: p2 }, { v: p3 }];
        }
    },

    getPoint: (bez, t) => {
        if (!bez) return { x: 0, y: 0 };
        const p = bez.controlPoints.map(cp => cp.v);
        if (p.length < 4 || p.some(cp => !cp || cp.x === undefined)) {
            return { x: 0, y: 0 };
        }
        const mt = 1 - t;
        return {
            x: mt ** 3 * (p[0].x || 0) + 3 * mt ** 2 * t * (p[1].x || 0) + 3 * mt * t ** 2 * (p[2].x || 0) + t ** 3 * (p[3].x || 0),
            y: mt ** 3 * (p[0].y || 0) + 3 * mt ** 2 * t * (p[1].y || 0) + 3 * mt * t ** 2 * (p[2].y || 0) + t ** 3 * (p[3].y || 0)
        };
    },

    getTangent: (bez, t) => {
        if (!bez) return { dx: 0, dy: 0 };
        const p = bez.controlPoints.map(cp => cp.v);
        if (p.length < 4 || p.some(cp => !cp || cp.x === undefined)) {
            return { dx: 0, dy: 0 };
        }
        const mt = 1 - t;
        const dx = 3 * mt ** 2 * ((p[1].x || 0) - (p[0].x || 0)) + 6 * mt * t * ((p[2].x || 0) - (p[1].x || 0)) + 3 * t ** 2 * ((p[3].x || 0) - (p[2].x || 0));
        const dy = 3 * mt ** 2 * ((p[1].y || 0) - (p[0].y || 0)) + 6 * mt * t * ((p[2].y || 0) - (p[1].y || 0)) + 3 * t ** 2 * ((p[3].y || 0) - (p[2].y || 0));
        return { dx, dy };
    },

    getShapeThickness: (shape, t) => {
        const data = shape.strokeWidthData || [{ t: 0, w: 10 }, { t: 1, w: 10 }];
        if (data.length === 0) return 10;
        if (data.length === 1) return data[0].w;

        if (t <= data[0].t) return data[0].w;
        if (t >= data[data.length - 1].t) return data[data.length - 1].w;

        for (let i = 0; i < data.length - 1; i++) {
            const p1 = data[i];
            const p2 = data[i + 1];
            if (t >= p1.t && t <= p2.t) {
                const ratio = (t - p1.t) / (p2.t - p1.t);
                return p1.w + ratio * (p2.w - p1.w);
            }
        }
        return data[data.length - 1].w;
    },

    generateOutlinePathPoints: (shape, beziers) => {
        // MEMO: 太さ0の範囲については、計算誤差でわずかにかすれた線が見える場合がありますが、追々、ブラシ機能を拡充するときに最適化などを検討します。
        const leftPoints = [];
        const rightPoints = [];

        if (shape.type === 'polyline') {
            const pts = shape.points;
            if (!pts || pts.length < 2) return { leftPoints, rightPoints };

            const dists = [0];
            for (let i = 1; i < pts.length; i++) {
                dists.push(dists[i-1] + Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y));
            }
            const totalLen = dists[dists.length - 1];

            for (let i = 0; i < pts.length; i++) {
                const p = pts[i];
                const tGlobal = totalLen > 0.001 ? dists[i] / totalLen : i / (pts.length - 1);

                let dx = 0, dy = 0;
                if (pts.length > 1) {
                    if (i === 0) {
                        dx = pts[1].x - pts[0].x;
                        dy = pts[1].y - pts[0].y;
                    } else if (i === pts.length - 1) {
                        dx = pts[pts.length - 1].x - pts[pts.length - 2].x;
                        dy = pts[pts.length - 1].y - pts[pts.length - 2].y;
                    } else {
                        dx = (pts[i+1].x - pts[i-1].x) / 2;
                        dy = (pts[i+1].y - pts[i-1].y) / 2;
                    }
                }

                const len = Math.hypot(dx, dy);
                let nx = 0, ny = 0;
                if (len > 1e-6) {
                    nx = -dy / len;
                    ny = dx / len;
                }

                const w = MDMath.getShapeThickness(shape, tGlobal);
                const r = w / 2;

                leftPoints.push({ x: p.x + nx * r, y: p.y + ny * r });
                rightPoints.push({ x: p.x - nx * r, y: p.y - ny * r });
            }
            return { leftPoints, rightPoints };
        }

        const N = shape.bezierIds ? shape.bezierIds.length : 0;
        if (N === 0) return { leftPoints, rightPoints };

        for (let i = 0; i < N; i++) {
            const bid = shape.bezierIds[i];
            const bez = beziers[bid];
            if (!bez) continue;

            const ts = Object.keys(bez.samplePointByT || {}).map(Number).sort((a, b) => a - b);
            if (ts.length === 0) {
                ts.push(0, 1);
            }

            ts.forEach((tLocal) => {
                const tGlobal = (i + tLocal) / N;
                const p = (bez.samplePointByT && bez.samplePointByT[tLocal]) || MDMath.getPoint(bez, tLocal);

                let tangent = MDMath.getTangent(bez, tLocal);
                let len = Math.hypot(tangent.dx, tangent.dy);
                if (len < 1e-6) {
                    const t2 = tLocal < 0.5 ? tLocal + 0.001 : tLocal - 0.001;
                    tangent = MDMath.getTangent(bez, t2);
                    len = Math.hypot(tangent.dx, tangent.dy);
                }

                let nx = 0, ny = 0;
                if (len > 1e-6) {
                    nx = -tangent.dy / len;
                    ny = tangent.dx / len;
                }

                const w = MDMath.getShapeThickness(shape, tGlobal);
                const r = w / 2;

                leftPoints.push({ x: p.x + nx * r, y: p.y + ny * r });
                rightPoints.push({ x: p.x - nx * r, y: p.y - ny * r });
            });
        }
        return { leftPoints, rightPoints };
    },

    getOutlinePathD: (shape, beziers) => {
        const { leftPoints, rightPoints } = MDMath.generateOutlinePathPoints(shape, beziers);
        if (leftPoints.length === 0) return '';

        let d = '';
        d += `M ${leftPoints[0].x},${leftPoints[0].y}`;
        for (let i = 1; i < leftPoints.length; i++) {
            d += ` L ${leftPoints[i].x},${leftPoints[i].y}`;
        }
        for (let i = rightPoints.length - 1; i >= 0; i--) {
            d += ` L ${rightPoints[i].x},${rightPoints[i].y}`;
        }
        d += ' Z';
        return d;
    },

    getShapePointAndNormal: (shape, t, beziers) => {
        if (shape.type === 'polyline') {
            const pts = shape.points;
            if (!pts || pts.length < 2) return { p: { x: 0, y: 0 }, nx: 0, ny: 0 };

            const dists = [0];
            for (let i = 1; i < pts.length; i++) {
                dists.push(dists[i-1] + Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y));
            }
            const totalLen = dists[dists.length - 1];
            const targetDist = t * totalLen;

            let idx = 0;
            while (idx < dists.length - 2 && dists[idx + 1] < targetDist) {
                idx++;
            }

            const d0 = dists[idx];
            const d1 = dists[idx + 1];
            const frac = (d1 - d0) > 0.001 ? (targetDist - d0) / (d1 - d0) : 0;

            const p0 = pts[idx];
            const p1 = pts[idx + 1];

            const p = {
                x: p0.x * (1 - frac) + p1.x * frac,
                y: p0.y * (1 - frac) + p1.y * frac
            };

            const dx = p1.x - p0.x;
            const dy = p1.y - p0.y;
            const len = Math.hypot(dx, dy);
            let nx = 0, ny = 0;
            if (len > 1e-6) {
                nx = -dy / len;
                ny = dx / len;
            }
            return { p, nx, ny };
        }

        const N = shape.bezierIds ? shape.bezierIds.length : 0;
        if (N === 0) return { p: { x: 0, y: 0 }, nx: 0, ny: 0 };

        t = Math.max(0, Math.min(1, t));

        let i = Math.floor(t * N);
        if (i >= N) i = N - 1;
        const tLocal = t * N - i;

        const bid = shape.bezierIds[i];
        const bez = beziers[bid];
        if (!bez) return { p: { x: 0, y: 0 }, nx: 0, ny: 0 };

        const p = MDMath.getPoint(bez, tLocal);

        let tangent = MDMath.getTangent(bez, tLocal);
        let len = Math.hypot(tangent.dx, tangent.dy);
        if (len < 1e-6) {
            const t2 = tLocal < 0.5 ? tLocal + 0.001 : tLocal - 0.001;
            tangent = MDMath.getTangent(bez, t2);
            len = Math.hypot(tangent.dx, tangent.dy);
        }

        let nx = 0, ny = 0;
        if (len > 1e-6) {
            nx = -tangent.dy / len;
            ny = tangent.dx / len;
        }

        return { p, nx, ny };
    },

    transformCircle: (obj, x0, y0, a, r) => {
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        const dx = obj.x - x0;
        const dy = obj.y - y0;
        obj.x = x0 + (dx * cos - dy * sin) * r;
        obj.y = y0 + (dx * sin + dy * cos) * r;
        if (obj.a !== undefined) obj.a += a;
        if (obj.r !== undefined) obj.r *= r;
    }
};
