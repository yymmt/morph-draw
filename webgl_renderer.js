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

function initWebGLPatternRenderer() {
    const canvas = document.createElement('canvas');
    canvas.width = state.canvas.width;
    canvas.height = state.canvas.height;
    
    let gl = null;
    try {
        gl = canvas.getContext('webgl', { alpha: true, antialias: true }) || 
             canvas.getContext('experimental-webgl', { alpha: true, antialias: true });
    } catch (e) {
        console.warn("WebGL not supported in this environment");
    }
    
    if (!gl) return;
    
    state.patternWebGLCanvas = canvas;
    state.gl = gl;
    
    function compileShader(type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        return shader;
    }
    
    const vs = compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = compileShader(gl.FRAGMENT_SHADER, fsSource);
    
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    state.webglProgram = program;
    
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
    state.texCoordBuffer = texCoordBuffer;
    
    const indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(meshIndices), gl.STATIC_DRAW);
    state.indexBuffer = indexBuffer;
    state.meshIndexCount = meshIndices.length;
    
    const positionBuffer = gl.createBuffer();
    state.positionBuffer = positionBuffer;
    
    // Initialize WebGL Texture Dictionary
    state.webglTextures = {};
    
    // Load Fills and Strokes with fallback
    loadWebGLTexture('sample', 'image/sample.png', drawFallbackLeaf);
    loadWebGLTexture('brush_sample', 'image/brush_sample.png', drawFallbackBrush);
}

function loadWebGLTexture(name, src, fallbackDrawFn) {
    const gl = state.gl;
    if (!gl) return;
    
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    
    // Procedural Fallback
    if (fallbackDrawFn) {
        fallbackDrawFn(texture);
    } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([200, 200, 200, 255]));
    }
    
    state.webglTextures[name] = texture;
    
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
            console.warn(`Failed to load texture image: ${src}, using procedural fallback.`);
        };
        image.src = src;
    }
}

function drawFallbackLeaf(texture) {
    if (typeof document === 'undefined') return;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    
    ctx.clearRect(0, 0, 256, 256);
    ctx.fillStyle = '#4caf50';
    ctx.beginPath();
    ctx.moveTo(32, 224);
    ctx.quadraticCurveTo(128, 224, 224, 128);
    ctx.quadraticCurveTo(224, 32, 128, 32);
    ctx.quadraticCurveTo(32, 128, 32, 224);
    ctx.fill();
    
    ctx.strokeStyle = '#8bc34a';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(32, 224);
    ctx.lineTo(160, 96);
    ctx.stroke();
    
    const gl = state.gl;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

function drawFallbackBrush(texture) {
    if (typeof document === 'undefined') return;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    
    ctx.clearRect(0, 0, 256, 64);
    ctx.strokeStyle = '#ff9800';
    ctx.lineWidth = 8;
    ctx.lineCap = 'round';
    for (let x = -16; x < 256; x += 24) {
        ctx.beginPath();
        ctx.moveTo(x, 8);
        ctx.lineTo(x + 32, 56);
        ctx.stroke();
    }
    
    const gl = state.gl;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

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

function getShapePoint(shape, t) {
    return MDMath.getShapePointAndNormal(shape, t, state.beziers).p;
}

function initPatternCorners(shape) {
    const N = shape.bezierIds ? shape.bezierIds.length : 0;
    if (N === 0) return;
    
    const numSamples = 100;
    const samples = [];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    
    for (let step = 0; step < numSamples; step++) {
        const t = step / numSamples;
        const p = getShapePoint(shape, t);
        samples.push({ t, x: p.x, y: p.y });
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    }
    
    const targets = {
        TL: { x: minX, y: minY },
        TR: { x: maxX, y: minY },
        BR: { x: maxX, y: maxY },
        BL: { x: minX, y: maxY }
    };
    
    const corners = {};
    Object.keys(targets).forEach(key => {
        const target = targets[key];
        let closestSample = null;
        let minDist = Infinity;
        samples.forEach(s => {
            const dist = Math.hypot(s.x - target.x, s.y - target.y);
            if (dist < minDist) {
                minDist = dist;
                closestSample = s;
            }
        });
        corners[key] = closestSample ? closestSample.t : 0.0;
    });
    
    shape.patternCorners = corners;
}

function generateCoonsPatchMesh(shape) {
    const corners = shape.patternCorners;
    if (!corners) return null;
    
    const tTL = corners.TL;
    const tTR = corners.TR;
    const tBR = corners.BR;
    const tBL = corners.BL;
    
    const GRID_SIZE = 32;
    const positions = [];
    
    const pTL = getShapePoint(shape, tTL);
    const pTR = getShapePoint(shape, tTR);
    const pBR = getShapePoint(shape, tBR);
    const pBL = getShapePoint(shape, tBL);
    
    for (let j = 0; j <= GRID_SIZE; j++) {
        const v = j / GRID_SIZE;
        for (let i = 0; i <= GRID_SIZE; i++) {
            const u = i / GRID_SIZE;
            
            const c0 = getShapePoint(shape, interpolatePerimeter(tBL, tBR, u));
            const c1 = getShapePoint(shape, interpolatePerimeter(tTL, tTR, u));
            const d0 = getShapePoint(shape, interpolatePerimeter(tBL, tTL, v));
            const d1 = getShapePoint(shape, interpolatePerimeter(tBR, tTR, v));
            
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

function generateStrokeCoonsPatchMesh(shape) {
    const { leftPoints, rightPoints } = MDMath.generateOutlinePathPoints(shape, state.beziers);
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

function renderPatternWebGL(positions, textureName) {
    const gl = state.gl;
    if (!gl || !state.patternWebGLCanvas || !positions) return null;
    
    const texture = state.webglTextures[textureName];
    if (!texture) return null;
    
    gl.viewport(0, 0, state.patternWebGLCanvas.width, state.patternWebGLCanvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    
    gl.useProgram(state.webglProgram);
    
    const aPosition = gl.getAttribLocation(state.webglProgram, 'a_position');
    gl.enableVertexAttribArray(aPosition);
    gl.bindBuffer(gl.ARRAY_BUFFER, state.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);
    
    const aTexCoord = gl.getAttribLocation(state.webglProgram, 'a_texCoord');
    gl.enableVertexAttribArray(aTexCoord);
    gl.bindBuffer(gl.ARRAY_BUFFER, state.texCoordBuffer);
    gl.vertexAttribPointer(aTexCoord, 2, gl.FLOAT, false, 0, 0);
    
    const uResolution = gl.getUniformLocation(state.webglProgram, 'u_resolution');
    gl.uniform2f(uResolution, state.canvas.width, state.canvas.height);
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, state.indexBuffer);
    gl.drawElements(gl.TRIANGLES, state.meshIndexCount, gl.UNSIGNED_SHORT, 0);
    
    return state.patternWebGLCanvas;
}
