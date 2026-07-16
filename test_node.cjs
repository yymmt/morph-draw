const fs = require('fs');
const vm = require('vm');
const path = require('path');

// Helper to strip TS-specific syntax for VM execution
const cleanTsCode = (code) => {
    return code
        .replace(/\s+as\s+any/g, '')
        .replace(/^import\s+['"].*?['"];?/gm, '')
        .replace(/^export\s+.*?;?/gm, '');
};

// mdmath.ts のコードを読み込む
const mdmathJsPath = path.join(__dirname, 'src', 'mdmath.ts');
if (!fs.existsSync(mdmathJsPath)) {
    console.error(`Error: Cannot find mdmath.ts at ${mdmathJsPath}`);
    process.exit(1);
}
const mdmathJsCode = cleanTsCode(fs.readFileSync(mdmathJsPath, 'utf8'));

// webgl_renderer.ts のコードを読み込む
const webglRendererJsPath = path.join(__dirname, 'src', 'webgl_renderer.ts');
if (!fs.existsSync(webglRendererJsPath)) {
    console.error(`Error: Cannot find webgl_renderer.ts at ${webglRendererJsPath}`);
    process.exit(1);
}
const webglRendererJsCode = cleanTsCode(fs.readFileSync(webglRendererJsPath, 'utf8'));

// 新しい分離ファイルを読み込む
const stateJsPath = path.join(__dirname, 'src', 'state.ts');
const dbJsPath = path.join(__dirname, 'src', 'db.ts');
const historyJsPath = path.join(__dirname, 'src', 'history.ts');
const rendererJsPath = path.join(__dirname, 'src', 'renderer.ts');
const editorJsPath = path.join(__dirname, 'src', 'editor.ts');
const mainJsPath = path.join(__dirname, 'src', 'main.ts');

const stateJsCode = cleanTsCode(fs.readFileSync(stateJsPath, 'utf8'));
const dbJsCode = cleanTsCode(fs.readFileSync(dbJsPath, 'utf8'));
const historyJsCode = cleanTsCode(fs.readFileSync(historyJsPath, 'utf8'));
const rendererJsCode = cleanTsCode(fs.readFileSync(rendererJsPath, 'utf8'));
const editorJsCode = cleanTsCode(fs.readFileSync(editorJsPath, 'utf8'));
const mainJsCode = cleanTsCode(fs.readFileSync(mainJsPath, 'utf8'));

// ダミー要素のファクトリ
const createDummyElement = () => ({
    width: 0,
    height: 0,
    getBoundingClientRect: () => ({ width: 200, height: 200, top: 0, left: 0, right: 200, bottom: 200 }),
    cloneNode: () => createDummyElement(),
    classList: {
        toggle: () => { },
        add: () => { },
        remove: () => { }
    },
    getContext: () => ({
        clearRect: () => { },
        save: () => { },
        restore: () => { },
        translate: () => { },
        scale: () => { },
        rotate: () => { },
        drawImage: () => { }
    }),
    toBlob: (cb) => cb(new sandbox.Blob()),
    setAttribute: () => { },
    appendChild: () => { },
    querySelector: () => createDummyElement(),
    querySelectorAll: () => [createDummyElement()],
    createSVGPoint: () => ({
        x: 0,
        y: 0,
        matrixTransform: () => ({ x: 0, y: 0 })
    }),
    getScreenCTM: () => ({
        inverse: () => ({})
    })
});

// ブラウザ環境のモックコンテキストを作成
const sandbox = {
    crypto: {
        randomUUID: () => 'test-uuid-1234'
    },
    document: {
        addEventListener: () => { },
        getElementById: () => createDummyElement(),
        createElement: () => createDummyElement(),
        createElementNS: () => createDummyElement(),
        querySelectorAll: () => [createDummyElement()]
    },
    window: {
        addEventListener: () => { },
        devicePixelRatio: 1
    },
    Blob: class { },
    URL: {
        createObjectURL: (blob) => 'blob:mock-url',
        revokeObjectURL: (url) => { }
    },
    console: console,
    Math: Math,
    Object: Object,
    Array: Array,
    JSON: JSON,
    parseFloat: parseFloat,
    parseInt: parseInt
};

// 全ての新ファイルを仮想環境で実行して状態と関数をロード
try {
    vm.createContext(sandbox);
    vm.runInContext(mdmathJsCode, sandbox);
    vm.runInContext(webglRendererJsCode, sandbox);
    vm.runInContext(stateJsCode, sandbox);
    vm.runInContext(dbJsCode, sandbox);
    vm.runInContext(historyJsCode, sandbox);
    vm.runInContext(rendererJsCode, sandbox);
    vm.runInContext(editorJsCode, sandbox);
    vm.runInContext(mainJsCode, sandbox);
    vm.runInContext("globalThis.state = state;", sandbox);
} catch (err) {
    console.error('❌ Failed to load files in test context:', err);
    process.exit(1);
}

// 1. 軽量化シリアライズ & キャッシュ復元テスト (Pure Function Test)
try {
    const state = sandbox.state;
    state.shapes = {
        'shape-1': {
            id: 'shape-1',
            bezierIds: ['bez-1'],
            type: 'bezier-group'
        }
    };
    state.beziers = {
        'bez-1': {
            id: 'bez-1',
            generator: {
                type: 'arc',
                params: { x: 100, y: 100, r: 50, startAngle: 0, endAngle: 1.57 }
            },
            controlPoints: [
                { v: { x: 150, y: 100 } },
                { v: { x: 150, y: 127 } },
                { v: { x: 135, y: 150 } },
                { v: { x: 100, y: 150 } }
            ],
            samplePointByT: {}
        }
    };
    state.selectedShapeIds = ['shape-1'];

    const serialized = vm.runInContext("JSON.stringify({ shapes: state.shapes, beziers: state.beziers }, stateReplacer)", sandbox);
    const parsed = JSON.parse(serialized);

    if (parsed.beziers['bez-1'].controlPoints !== undefined) {
        throw new Error('controlPoints was not excluded by stateReplacer');
    }

    sandbox.state.beziers = parsed.beziers;
    sandbox.state.shapes = parsed.shapes;
    vm.runInContext("resolveBezierDependencies()", sandbox);

    const recoveredBez = sandbox.state.beziers['bez-1'];
    if (!recoveredBez.controlPoints || recoveredBez.controlPoints.length !== 4) {
        throw new Error('controlPoints recovery failed after resolveBezierDependencies');
    }
    console.log('✅ test_node.js: serialization & cache recovery test passed!');
} catch (err) {
    console.error('❌ test_node.js: serialization test failed!', err);
    process.exit(1);
}

// 2. 動的太さ補間テスト (Pure Math Test)
try {
    const testShape = {
        id: 's_test',
        type: 'bezier-group',
        bezierIds: ['bez-1'],
        style: { fill: '#2196F3', opacity: 0.7, outline: true, fillEnabled: true },
        strokeWidthData: [{ t: 0, w: 10 }, { t: 0.5, w: 2 }, { t: 1, w: 10 }]
    };
    sandbox.state.shapes['s_test'] = testShape;
    sandbox.state.selectedShapeIds = ['s_test'];

    const w0 = vm.runInContext("MDMath.getShapeThickness(state.shapes['s_test'], 0.0)", sandbox);
    const w025 = vm.runInContext("MDMath.getShapeThickness(state.shapes['s_test'], 0.25)", sandbox);
    const w05 = vm.runInContext("MDMath.getShapeThickness(state.shapes['s_test'], 0.5)", sandbox);
    const w1 = vm.runInContext("MDMath.getShapeThickness(state.shapes['s_test'], 1.0)", sandbox);

    if (w0 !== 10) throw new Error(`w(0) should be 10, got ${w0}`);
    if (Math.abs(w025 - 6) > 1e-4) throw new Error(`w(0.25) should be 6, got ${w025}`);
    if (w05 !== 2) throw new Error(`w(0.5) should be 2, got ${w05}`);
    if (w1 !== 10) throw new Error(`w(1) should be 10, got ${w1}`);
    console.log('✅ test_node.js: thickness interpolation test passed!');
} catch (err) {
    console.error('❌ test_node.js: thickness interpolation test failed!', err);
    process.exit(1);
}

// 3. WebGL クーンズ面パターン塗りの境界算出テスト (Pure Data & Math Test)
try {
    const testStatePattern = {
        shapes: {
            's_pattern': {
                id: 's_pattern',
                type: 'bezier-group',
                bezierIds: ['b1', 'b2', 'b3', 'b4'],
                style: { fillPattern: 'sample' }
            }
        },
        beziers: {
            'b1': {
                id: 'b1',
                controlPoints: [{ v: { x: 100, y: 100 } }, { v: { x: 133, y: 100 } }, { v: { x: 166, y: 100 } }, { v: { x: 200, y: 100 } }],
                samplePointByT: { 0: { x: 100, y: 100 }, 1: { x: 200, y: 100 } }
            },
            'b2': {
                id: 'b2',
                controlPoints: [{ v: { x: 200, y: 100 } }, { v: { x: 200, y: 133 } }, { v: { x: 200, y: 166 } }, { v: { x: 200, y: 200 } }],
                samplePointByT: { 0: { x: 200, y: 100 }, 1: { x: 200, y: 200 } }
            },
            'b3': {
                id: 'b3',
                controlPoints: [{ v: { x: 200, y: 200 } }, { v: { x: 166, y: 200 } }, { v: { x: 133, y: 200 } }, { v: { x: 100, y: 200 } }],
                samplePointByT: { 0: { x: 200, y: 200 }, 1: { x: 100, y: 200 } }
            },
            'b4': {
                id: 'b4',
                controlPoints: [{ v: { x: 100, y: 200 } }, { v: { x: 100, y: 166 } }, { v: { x: 100, y: 133 } }, { v: { x: 100, y: 100 } }],
                samplePointByT: { 0: { x: 100, y: 200 }, 1: { x: 100, y: 100 } }
            }
        },
        selectedShapeIds: ['s_pattern']
    };
    sandbox.testStatePattern = testStatePattern;
    vm.runInContext("state.reset(testStatePattern);", sandbox);

    // initPatternCorners
    vm.runInContext("initPatternCorners(state.shapes['s_pattern'])", sandbox);
    const corners = vm.runInContext("state.shapes['s_pattern'].patternCorners", sandbox);
    if (!corners) {
        throw new Error('initPatternCorners did not set shape.patternCorners');
    }
    if (typeof corners.TL !== 'number' || typeof corners.TR !== 'number' ||
        typeof corners.BR !== 'number' || typeof corners.BL !== 'number') {
        throw new Error('Corners should contain TL, TR, BR, BL parameters');
    }
    console.log('✅ test_node.js: initPatternCorners test passed!');

    // generateCoonsPatchMesh
    const mesh = vm.runInContext("generateCoonsPatchMesh(state.shapes['s_pattern'])", sandbox);
    if (!mesh) {
        throw new Error('generateCoonsPatchMesh returned null');
    }
    const expectedCount = 33 * 33 * 2;
    if (mesh.length !== expectedCount) {
        throw new Error(`Expected mesh length to be ${expectedCount}, got ${mesh.length}`);
    }
    console.log('✅ test_node.js: generateCoonsPatchMesh test passed!');

    // generateStrokeCoonsPatchMesh
    const strokeMesh = vm.runInContext("generateStrokeCoonsPatchMesh(state.shapes['s_pattern'])", sandbox);
    if (!strokeMesh) {
        throw new Error('generateStrokeCoonsPatchMesh returned null');
    }
    if (strokeMesh.length !== expectedCount) {
        throw new Error(`Expected stroke mesh length to be ${expectedCount}, got ${strokeMesh.length}`);
    }
    console.log('✅ test_node.js: generateStrokeCoonsPatchMesh test passed!');

} catch (err) {
    console.error('❌ test_node.js: Coons Patch tests failed!', err);
    process.exit(1);
}

// 4. 結合バウンズ境界算出テスト (Pure Data Test)
try {
    const testStateC = {
        shapes: {
            's1': { id: 's1', type: 'bezier-group', name: 'circle 1', bezierIds: ['b1'] },
            's2': { id: 's2', type: 'bezier-group', name: 'circle 2', bezierIds: ['b2'] }
        },
        beziers: {
            'b1': {
                id: 'b1',
                generator: { type: 'arc', params: { x: 100, y: 100, r: 50, startAngle: 0, endAngle: 1.57 } },
                controlPoints: [{ v: { x: 100, y: 100 } }], boundingBox: { x: 50, y: 50, w: 100, h: 100 }
            },
            'b2': {
                id: 'b2',
                generator: { type: 'arc', params: { x: 300, y: 300, r: 50, startAngle: 0, endAngle: 1.57 } },
                controlPoints: [{ v: { x: 300, y: 300 } }], boundingBox: { x: 250, y: 250, w: 100, h: 100 }
            }
        },
        selectedShapeIds: ['s1', 's2']
    };
    sandbox.testStateC = testStateC;
    vm.runInContext("state.reset(testStateC);", sandbox);

    const bounds = vm.runInContext("getCombinedBounds(state.selectedShapeIds)", sandbox);
    if (bounds.cx !== 200 || bounds.cy !== 200) {
        throw new Error(`Expected combined bounds center at (200, 200), got (${bounds.cx}, ${bounds.cy})`);
    }
    console.log('✅ test_node.js: Combined bounds test passed!');
} catch (err) {
    console.error('❌ test_node.js: Combined bounds test failed!', err);
    process.exit(1);
}

// 5. ラスター描画・点列変換テスト
try {
    const testStateRaster = {
        shapes: {},
        beziers: {},
        scene: ['layer-1'],
        selectedLayerId: 'layer-1',
        draftStrokes: [],
        currentDraftStroke: null
    };
    sandbox.testStateRaster = testStateRaster;
    vm.runInContext("state.reset(testStateRaster); state.shapes['layer-1'] = { id: 'layer-1', type: 'layer', childIds: [] }; state.scene = ['layer-1']; state.selectedLayerId = 'layer-1'; state.view = 'canvas';", sandbox);

    // dキー押下中のpointermoveエミュレーション
    vm.runInContext("state.input.keys['d'] = true;", sandbox);

    const strokePoints = [
        { x: 100, y: 100 },
        { x: 110, y: 105 },
        { x: 120, y: 110 },
        { x: 130, y: 115 },
        { x: 140, y: 120 }
    ];

    for (const pt of strokePoints) {
        sandbox.mockPt = pt;
        vm.runInContext("state.input.pointerOnSVG = mockPt;", sandbox);
        vm.runInContext("handleInputUpdate({ type: 'pointermove' });", sandbox);
    }

    // dキー離す(keyup)
    vm.runInContext("state.input.keys['d'] = false; handleInputUpdate_old('keyup', 'd', { preventDefault: () => {} }); handleInputUpdate({ type: 'keyup', key: 'd' });", sandbox);

    // draftStrokesに1本記録されたか確認
    const draftStrokesLen = vm.runInContext("state.draftStrokes.length", sandbox);
    if (draftStrokesLen !== 1) {
        throw new Error(`Expected draftStrokes.length to be 1, got ${draftStrokesLen}`);
    }

    // pキー押下(keydown)で点列変換実行
    vm.runInContext("state.input.keys['p'] = true; handleInputUpdate_old('keydown', 'p', { preventDefault: () => {} }); handleInputUpdate({ type: 'keydown', key: 'p' });", sandbox);

    // 新しいshapeが追加されたか確認
    const shapes = vm.runInContext("state.shapes", sandbox);
    const polylineShape = Object.values(shapes).find(s => s.type === 'polyline');
    if (!polylineShape) {
        throw new Error('Expected polyline shape to be created, but none found');
    }

    if (polylineShape.points.length < 2) {
        throw new Error(`Expected polyline points length to be >= 2, got ${polylineShape.points.length}`);
    }

    console.log('✅ test_node.js: Raster to polyline parsing test passed!');
} catch (err) {
    console.error('❌ test_node.js: Raster to polyline test failed!', err);
    process.exit(1);
}

console.log('🎉 All clean unit tests passed successfully!');
process.exit(0);
