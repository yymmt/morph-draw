/**
 * MorphDraw - WebGL パターンレンダラー & メッシュジェネレータ
 */

const vsSource = `
    attribute vec2 a_position;
    attribute vec2 a_texCoord;
    uniform vec2 u_resolution;
    varying vec2 v_texCoord;
    void main() {
        vec2 zeroToOne = a_position / u_resolution;
        vec2 zeroToTwo = zeroToOne * 2.0;
        vec2 clipSpace = zeroToTwo - 1.0;
        gl_Position = vec4(clipSpace * vec2(1.0, -1.0), 0.0, 1.0);
        v_texCoord = a_texCoord;
    }
`;

const fsSource = `
    precision mediump float;
    varying vec2 v_texCoord;
    uniform sampler2D u_texture;
    void main() {
        gl_FragColor = texture2D(u_texture, v_texCoord);
    }
`;

const WebGLRenderer = {
    canvas: null,
    gl: null,
    program: null,
    texCoordBuffer: null,
    indexBuffer: null,
    positionBuffer: null,
    meshIndexCount: 0,
    textures: {},

    init(width, height) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        this.canvas = canvas;

        let gl = null;
        try {
            gl = canvas.getContext('webgl', { alpha: true, antialias: true }) ||
                 canvas.getContext('experimental-webgl', { alpha: true, antialias: true });
        } catch (e) {
            console.warn("WebGL not supported in this environment");
        }

        if (!gl) return;
        this.gl = gl;

        const compileShader = (type, source) => {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            return shader;
        };

        const vs = compileShader(gl.VERTEX_SHADER, vsSource);
        const fs = compileShader(gl.FRAGMENT_SHADER, fsSource);

        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        this.program = program;

        gl.useProgram(program);

        const GRID_SIZE = 32;
        const meshIndices = [];
        const meshTexCoords = [];
        for (let j = 0; j <= GRID_SIZE; j++) {
            for (let i = 0; i <= GRID_SIZE; i++) {
                meshTexCoords.push(i / GRID_SIZE, j / GRID_SIZE);
            }
        }
        for (let j = 0; j < GRID_SIZE; j++) {
            for (let i = 0; i < GRID_SIZE; i++) {
                const p0 = j * (GRID_SIZE + 1) + i;
                const p1 = p0 + 1;
                const p2 = (j + 1) * (GRID_SIZE + 1) + i;
                const p3 = p2 + 1;
                meshIndices.push(p0, p1, p2);
                meshIndices.push(p2, p1, p3);
            }
        }

        const texCoordBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(meshTexCoords), gl.STATIC_DRAW);
        this.texCoordBuffer = texCoordBuffer;

        const indexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(meshIndices), gl.STATIC_DRAW);
        this.indexBuffer = indexBuffer;
        this.meshIndexCount = meshIndices.length;

        this.positionBuffer = gl.createBuffer();
        this.textures = {};

        // デフォルトパターンの初期読み込み
        this.loadTexture('sample', 'image/sample.png');
        this.loadTexture('brush_sample', 'image/brush_sample.png');
    },

    resize(width, height) {
        if (this.canvas) {
            this.canvas.width = width;
            this.canvas.height = height;
        }
    },

    loadTexture(name, src) {
        const gl = this.gl;
        if (!gl) return;

        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);

        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([200, 200, 200, 255]));
        this.textures[name] = texture;

        if (typeof Image !== 'undefined') {
            const image = new Image();
            image.onload = () => {
                gl.bindTexture(gl.TEXTURE_2D, texture);
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            };
            image.onerror = () => {
                console.warn(`Failed to load texture image: ${src}`);
            };
            image.src = src;
        }
    },

    registerTextureFromImage(id, img) {
        const gl = this.gl;
        if (!gl) return null;

        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);

        const isPowerOf2 = (val) => (val & (val - 1)) === 0;
        const isPot = isPowerOf2(img.width) && isPowerOf2(img.height);

        if (isPot) {
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.generateMipmap(gl.TEXTURE_2D);
        } else {
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        }

        this.textures[id] = texture;
        return texture;
    },

    renderPattern(positions, textureName, canvasWidth, canvasHeight) {
        const gl = this.gl;
        if (!gl || !this.canvas || !positions) return null;

        const texture = this.textures[textureName];
        if (!texture) return null;

        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        gl.useProgram(this.program);

        const aPosition = gl.getAttribLocation(this.program, 'a_position');
        gl.enableVertexAttribArray(aPosition);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.DYNAMIC_DRAW);
        gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

        const aTexCoord = gl.getAttribLocation(this.program, 'a_texCoord');
        gl.enableVertexAttribArray(aTexCoord);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer);
        gl.vertexAttribPointer(aTexCoord, 2, gl.FLOAT, false, 0, 0);

        const uResolution = gl.getUniformLocation(this.program, 'u_resolution');
        gl.uniform2f(uResolution, canvasWidth, canvasHeight);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
        gl.drawElements(gl.TRIANGLES, this.meshIndexCount, gl.UNSIGNED_SHORT, 0);

        return this.canvas;
    }
};

function interpolatePerimeter(tA, tB, factor) {
    let diff = tB - tA;
    if (diff > 0.5) {
        diff -= 1.0;
    } else if (diff < -0.5) {
        diff += 1.0;
    }
    let t = tA + factor * diff;
    return ((t % 1) + 1) % 1;
}

function getShapePoint(shape, t, beziers) {
    return MDMath.getShapePointAndNormal(shape, t, beziers).p;
}

function initPatternCorners(shape) {
    const numPoints = shape.points ? shape.points.length : 0;
    if (numPoints >= 4) {
        const step = Math.floor(numPoints / 4);
        shape.patternCorners = {
            TL: 0,
            TR: Math.min(step, numPoints - 1),
            BR: Math.min(step * 2, numPoints - 1),
            BL: Math.min(step * 3, numPoints - 1)
        };
    } else {
        shape.patternCorners = { TL: 0, TR: 0, BR: 0, BL: 0 };
    }
}

function generateCoonsPatchMesh(shape, beziers) {
    const corners = shape.patternCorners;
    if (!corners) return null;

    const numPoints = shape.points ? shape.points.length : 0;
    if (numPoints === 0) return null;

    const getPointByPointIdx = (idx) => {
        const pt = shape.points[idx];
        if (!pt) return { x: 0, y: 0 };
        const bez = beziers[pt.bezierId];
        return MDMath.getPoint(bez, pt.t);
    };

    const pTL = getPointByPointIdx(corners.TL);
    const pTR = getPointByPointIdx(corners.TR);
    const pBR = getPointByPointIdx(corners.BR);
    const pBL = getPointByPointIdx(corners.BL);

    const GRID_SIZE = 32;
    const positions = [];

    const interpolatePoint = (idxStart, idxEnd, factor) => {
        const idxFloat = idxStart + factor * (idxEnd - idxStart);
        const idx0 = Math.floor(idxFloat);
        const idx1 = Math.min(numPoints - 1, idx0 + 1);
        const ratio = idxFloat - idx0;

        const p0 = getPointByPointIdx(idx0);
        const p1 = getPointByPointIdx(idx1);
        return {
            x: p0.x + ratio * (p1.x - p0.x),
            y: p0.y + ratio * (p1.y - p0.y)
        };
    };

    for (let j = 0; j <= GRID_SIZE; j++) {
        const v = j / GRID_SIZE;
        for (let i = 0; i <= GRID_SIZE; i++) {
            const u = i / GRID_SIZE;

            const c0 = interpolatePoint(corners.BL, corners.BR, u);
            const c1 = interpolatePoint(corners.TL, corners.TR, u);
            const d0 = interpolatePoint(corners.BL, corners.TL, v);
            const d1 = interpolatePoint(corners.BR, corners.TR, v);

            const bx = (1 - u) * (1 - v) * pBL.x +
                u * (1 - v) * pBR.x +
                (1 - u) * v * pTL.x +
                u * v * pTR.x;

            const by = (1 - u) * (1 - v) * pBL.y +
                u * (1 - v) * pBR.y +
                (1 - u) * v * pTL.y +
                u * v * pTR.y;

            const px = (1 - v) * c0.x + v * c1.x + (1 - u) * d0.x + u * d1.x - bx;
            const py = (1 - v) * c0.y + v * c1.y + (1 - u) * d0.y + u * d1.y - by;

            positions.push(px, py);
        }
    }

    return positions;
}

function generateStrokeCoonsPatchMesh(shape, beziers) {
    const { leftPoints, rightPoints } = MDMath.generateOutlinePathPoints(shape, beziers);
    const M = leftPoints.length;
    if (M < 2) return null;

    const GRID_SIZE = 32;
    const positions = [];

    for (let j = 0; j <= GRID_SIZE; j++) {
        const v = j / GRID_SIZE;
        for (let i = 0; i <= GRID_SIZE; i++) {
            const u = i / GRID_SIZE;

            const idx = u * (M - 1);
            const i0 = Math.floor(idx);
            const i1 = Math.min(M - 1, i0 + 1);
            const ratio = idx - i0;

            const pLeft = {
                x: leftPoints[i0].x + ratio * (leftPoints[i1].x - leftPoints[i0].x),
                y: leftPoints[i0].y + ratio * (leftPoints[i1].y - leftPoints[i0].y)
            };

            const pRight = {
                x: rightPoints[i0].x + ratio * (rightPoints[i1].x - rightPoints[i0].x),
                y: rightPoints[i0].y + ratio * (rightPoints[i1].y - rightPoints[i0].y)
            };

            const px = (1 - v) * pRight.x + v * pLeft.x;
            const py = (1 - v) * pRight.y + v * pLeft.y;

            positions.push(px, py);
        }
    }
    return positions;
}
