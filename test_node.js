const fs = require('fs');
const vm = require('vm');
const path = require('path');

// mdmath.js のコードを読み込む
const mdmathJsPath = path.join(__dirname, 'mdmath.js');
if (!fs.existsSync(mdmathJsPath)) {
    console.error(`Error: Cannot find mdmath.js at ${mdmathJsPath}`);
    process.exit(1);
}
const mdmathJsCode = fs.readFileSync(mdmathJsPath, 'utf8');

// webgl_renderer.js のコードを読み込む
const webglRendererJsPath = path.join(__dirname, 'webgl_renderer.js');
if (!fs.existsSync(webglRendererJsPath)) {
    console.error(`Error: Cannot find webgl_renderer.js at ${webglRendererJsPath}`);
    process.exit(1);
}
const webglRendererJsCode = fs.readFileSync(webglRendererJsPath, 'utf8');

// main.js のコードを読み込む
const mainJsPath = path.join(__dirname, 'main.js');
if (!fs.existsSync(mainJsPath)) {
    console.error(`Error: Cannot find main.js at ${mainJsPath}`);
    process.exit(1);
}
const mainJsCode = fs.readFileSync(mainJsPath, 'utf8');

// ダミー要素のファクトリ
const createDummyElement = () => ({
    width: 0,
    height: 0,
    getBoundingClientRect: () => ({ width: 200, height: 200, top: 0, left: 0, right: 200, bottom: 200 }),
    cloneNode: () => createDummyElement(),
    classList: {
        toggle: () => {},
        add: () => {},
        remove: () => {}
    },
    getContext: () => ({
        clearRect: () => {},
        save: () => {},
        restore: () => {},
        translate: () => {},
        scale: () => {},
        rotate: () => {},
        drawImage: () => {}
    }),
    toBlob: (cb) => cb(new sandbox.Blob()),
    setAttribute: () => {},
    appendChild: () => {},
    querySelector: () => createDummyElement(),
    querySelectorAll: () => []
});

// ブラウザ環境のモックコンテキストを作成
const sandbox = {
    // 最小限のグローバルオブジェクトとブラウザAPIのモック
    crypto: {
        randomUUID: () => 'test-uuid-1234'
    },
    document: {
        addEventListener: () => {},
        getElementById: () => createDummyElement(),
        createElement: () => createDummyElement(),
        createElementNS: () => createDummyElement()
    },
    window: {
        addEventListener: () => {},
        devicePixelRatio: 1
    },
    Blob: class {},
    URL: {
        createObjectURL: (blob) => 'blob:mock-url',
        revokeObjectURL: (url) => {}
    },
    console: console,
    Math: Math,
    Object: Object,
    Array: Array,
    JSON: JSON,
    parseFloat: parseFloat,
    parseInt: parseInt
};

// main.js を仮想環境で実行して状態と関数をロード
try {
    vm.createContext(sandbox);
    vm.runInContext(mdmathJsCode, sandbox);
    vm.runInContext(webglRendererJsCode, sandbox);
    vm.runInContext(mainJsCode, sandbox);
    // const や let で定義されたスコープ変数は global/sandbox のプロパティにならないため、明示的にエクスポートして紐付ける
    vm.runInContext("globalThis.state = state; globalThis.handleMove = handleMove;", sandbox);
} catch (err) {
    console.error('❌ Failed to load main.js in test context:', err);
    process.exit(1);
}

// sandboxからテスト対象のオブジェクトと関数を取り出す
const state = sandbox.state;
const handleMove = sandbox.handleMove;

// 1. テストデータの準備 (state の初期化)
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
            params: { x: 100, y: 100, r: 50, startAngle: 0, endAngle: 1.57 } // arc パラメータ
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

// 2. テスト実行
const ctx = { dx: 10, dy: 20 };
try {
    handleMove(ctx);
} catch (err) {
    console.error('❌ handleMove crashed during execution:', err);
    process.exit(1);
}

// 3. アサーション
const bez = state.beziers['bez-1'];
const expectedX = 110;
const expectedY = 120;

if (bez.generator.params.x === expectedX && bez.generator.params.y === expectedY) {
    console.log('✅ test_node.js: handleMove test passed!');
} else {
    console.error('❌ test_node.js: handleMove test failed!');
    console.error(`Expected generator x: ${expectedX}, y: ${expectedY}`);
    console.error(`Got generator x: ${bez.generator.params.x}, y: ${bez.generator.params.y}`);
    process.exit(1);
}

// --- 追加テスト1：軽量化シリアライズ & キャッシュ復元テスト ---
try {
    const serialized = vm.runInContext("JSON.stringify({ shapes: state.shapes, beziers: state.beziers }, stateReplacer)", sandbox);
    const parsed = JSON.parse(serialized);

    // アサーション： controlPoints などのキャッシュが除外されていること
    if (parsed.beziers['bez-1'].controlPoints !== undefined) {
        throw new Error('controlPoints was not excluded by stateReplacer');
    }

    // 復元テスト： resolveBezierDependencies を実行して controlPoints が再計算されること
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

// --- 追加テスト2：N-Wrap (頂点追加・削除) テスト ---
try {
    // 状態クリア
    sandbox.state.shapes = {};
    sandbox.state.beziers = {};
    sandbox.state.scene = [];
    sandbox.state.selectedShapeIds = [];
    sandbox.state.anchoredShapeIds = [];
    sandbox.state.focusedVertex = null;
    sandbox.state.insertVertexPending = null;

    // デフォルトレイヤー作成
    const layerId = vm.runInContext("generateId('l')", sandbox);
    sandbox.state.shapes[layerId] = {
        id: layerId,
        type: 'layer',
        name: 'Layer 1',
        childIds: [],
        style: { opacity: 1 },
        visible: true,
        locked: false
    };
    sandbox.state.scene = [layerId];
    sandbox.state.selectedLayerId = layerId;

    // 1. 円を2つ配置
    vm.runInContext("addShapeAt('circle', 300, 300)", sandbox);
    vm.runInContext("addShapeAt('circle', 500, 350)", sandbox);

    const circleIds = Object.keys(sandbox.state.shapes).filter(id => sandbox.state.shapes[id].name && sandbox.state.shapes[id].name.startsWith('circle'));
    if (circleIds.length !== 2) throw new Error('Failed to create 2 circles');

    // 2. wrap作成
    sandbox.state.anchoredShapeIds = [circleIds[0], circleIds[1]];
    vm.runInContext("createWrap()", sandbox);

    const wrapShape = Object.values(sandbox.state.shapes).find(s => s.name && s.name.startsWith('wrap'));
    if (!wrapShape) throw new Error('Failed to create wrap');
    if (wrapShape.bezierIds.length !== 4) throw new Error(`Wrap should have 4 beziers, got ${wrapShape.bezierIds.length}`);

    // 3. 3つ目の円を追加
    vm.runInContext("addShapeAt('circle', 400, 500)", sandbox);
    const allCircles = Object.keys(sandbox.state.shapes).filter(id => sandbox.state.shapes[id].name && sandbox.state.shapes[id].name.startsWith('circle'));
    const circleCId = allCircles.find(id => id !== circleIds[0] && id !== circleIds[1]);

    // 4. wrapを選択、頂点選択、aキー、円C選択、Enterキーのエミュレート
    sandbox.state.selectedShapeIds = [wrapShape.id];
    sandbox.state.anchoredShapeIds = [];
    
    // ArrowRightキー押下
    vm.runInContext("handleInputUpdate('keydown', 'ArrowRight', { preventDefault: () => {} })", sandbox);
    if (!sandbox.state.focusedVertex) throw new Error('Vertex focus failed');

    // aキー押下
    vm.runInContext("handleInputUpdate('keydown', 'a', { preventDefault: () => {} })", sandbox);
    if (!sandbox.state.insertVertexPending) throw new Error('insertVertexPending should be set');

    // 円Cを選択
    sandbox.state.selectedShapeIds = [circleCId];

    // Enterキー押下
    vm.runInContext("handleInputUpdate('keydown', 'Enter', { preventDefault: () => {} })", sandbox);

    // 5. アサーション：wrapのベジェが5本に増えていること
    if (wrapShape.bezierIds.length !== 5) {
        throw new Error(`Wrap bezier count should be 5, got ${wrapShape.bezierIds.length}`);
    }
    console.log('✅ test_node.js: N-Wrap vertex insertion test passed!');

    // 6. 頂点の削除テスト
    sandbox.state.focusedVertex = { shapeId: wrapShape.id, vertexIdx: 2 }; // 適当な頂点を選択
    vm.runInContext("handleInputUpdate('keydown', 'x', { preventDefault: () => {} })", sandbox);
    if (wrapShape.bezierIds.length !== 4) {
        throw new Error(`After deletion, Wrap bezier count should be 4, got ${wrapShape.bezierIds.length}`);
    }

    console.log('✅ test_node.js: N-Wrap vertex deletion test passed!');

    // --- 追加テスト3：動的太さ補間＆編集（トグル・補間・削除）テスト ---
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

        // 1. getShapeThickness の線形補間テスト
        const w0 = vm.runInContext("MDMath.getShapeThickness(state.shapes['s_test'], 0.0)", sandbox);
        const w025 = vm.runInContext("MDMath.getShapeThickness(state.shapes['s_test'], 0.25)", sandbox);
        const w05 = vm.runInContext("MDMath.getShapeThickness(state.shapes['s_test'], 0.5)", sandbox);
        const w1 = vm.runInContext("MDMath.getShapeThickness(state.shapes['s_test'], 1.0)", sandbox);

        if (w0 !== 10) throw new Error(`w(0) should be 10, got ${w0}`);
        if (Math.abs(w025 - 6) > 1e-4) throw new Error(`w(0.25) should be 6, got ${w025}`);
        if (w05 !== 2) throw new Error(`w(0.5) should be 2, got ${w05}`);
        if (w1 !== 10) throw new Error(`w(1) should be 10, got ${w1}`);
        console.log('✅ test_node.js: thickness interpolation test passed!');

        // 2. トグルキーイベントのシミュレート (Shift+s, Shift+f, Shift+w)
        vm.runInContext("handleInputUpdate('keydown', 's', { shiftKey: true, preventDefault: () => {} })", sandbox);
        if (testShape.style.outline !== false) throw new Error('Shift+s toggle outline failed');
        
        vm.runInContext("handleInputUpdate('keydown', 'f', { shiftKey: true, preventDefault: () => {} })", sandbox);
        if (testShape.style.fillEnabled !== false) throw new Error('Shift+f toggle fillEnabled failed');

        vm.runInContext("handleInputUpdate('keydown', 'w', { shiftKey: true, preventDefault: () => {} })", sandbox);
        if (sandbox.state.thicknessEdit.active !== true) throw new Error('Shift+w enable thicknessEdit failed');
        console.log('✅ test_node.js: outline/fill/thickness toggle test passed!');

        // 3. 太さ編集モード中のキー操作 (削除: x) のエミュレート
        sandbox.state.thicknessEdit.targetT = 0.5;
        vm.runInContext("handleInputUpdate('keydown', 'x', { preventDefault: () => {} })", sandbox);
        
        if (testShape.strokeWidthData.length !== 2) {
            throw new Error(`Thickness point deletion failed. strokeWidthData length should be 2, got ${testShape.strokeWidthData.length}`);
        }
        if (testShape.strokeWidthData.some(pt => pt.t === 0.5)) {
            throw new Error('Point t=0.5 should be deleted');
        }

        sandbox.state.thicknessEdit.targetT = 0.0;
        vm.runInContext("handleInputUpdate('keydown', 'x', { preventDefault: () => {} })", sandbox);
        if (testShape.strokeWidthData.length !== 2) {
            throw new Error('Endpoint t=0 should not be deletable');
        }

        console.log('✅ test_node.js: thickness edit key control test passed!');
    } catch (err) {
        console.error('❌ test_node.js: thickness test failed!', err);
        process.exit(1);
    }

    // --- 追加テスト5：WebGL クーンズ面パターン塗りのテスト ---
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
                    controlPoints: [{v: {x: 100, y: 100}}, {v: {x: 133, y: 100}}, {v: {x: 166, y: 100}}, {v: {x: 200, y: 100}}]
                },
                'b2': {
                    id: 'b2',
                    controlPoints: [{v: {x: 200, y: 100}}, {v: {x: 200, y: 133}}, {v: {x: 200, y: 166}}, {v: {x: 200, y: 200}}]
                },
                'b3': {
                    id: 'b3',
                    controlPoints: [{v: {x: 200, y: 200}}, {v: {x: 166, y: 200}}, {v: {x: 133, y: 200}}, {v: {x: 100, y: 200}}]
                },
                'b4': {
                    id: 'b4',
                    controlPoints: [{v: {x: 100, y: 200}}, {v: {x: 100, y: 166}}, {v: {x: 100, y: 133}}, {v: {x: 100, y: 100}}]
                }
            },
            selectedShapeIds: ['s_pattern']
        };
        sandbox.testStatePattern = testStatePattern;
        vm.runInContext("state.reset(testStatePattern);", sandbox);

        // 1. initPatternCorners の動作確認
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

        // 2. generateCoonsPatchMesh の動作確認
        const mesh = vm.runInContext("generateCoonsPatchMesh(state.shapes['s_pattern'])", sandbox);
        if (!mesh) {
            throw new Error('generateCoonsPatchMesh returned null');
        }
        const expectedCount = 33 * 33 * 2; // (GRID_SIZE+1)*(GRID_SIZE+1)*2
        if (mesh.length !== expectedCount) {
            throw new Error(`Expected mesh length to be ${expectedCount}, got ${mesh.length}`);
        }
        console.log('✅ test_node.js: generateCoonsPatchMesh test passed!');

        // 4. パターン編集モードトグル (Shift+p)
        vm.runInContext("handleTogglePatternEdit()", sandbox);
        if (sandbox.state.patternEdit.active !== true) {
            throw new Error('Shift+p did not activate patternEdit mode');
        }
        console.log('✅ test_node.js: handleTogglePatternEdit test passed!');

        // 5. generateStrokeCoonsPatchMesh の動作確認
        const strokeMesh = vm.runInContext("generateStrokeCoonsPatchMesh(state.shapes['s_pattern'])", sandbox);
        if (!strokeMesh) {
            throw new Error('generateStrokeCoonsPatchMesh returned null');
        }
        const expectedStrokeCount = 33 * 33 * 2;
        if (strokeMesh.length !== expectedStrokeCount) {
            throw new Error(`Expected stroke mesh length to be ${expectedStrokeCount}, got ${strokeMesh.length}`);
        }
        console.log('✅ test_node.js: generateStrokeCoonsPatchMesh test passed!');
        
    } catch (err) {
        console.error('❌ test_node.js: WebGL pattern fill test failed!', err);
        process.exit(1);
    }

    // --- 新規追加テスト：コピペとグループ変形のテスト ---
    try {
        // (a) 全て選択してコピー＆ペースト
        const testStateA = {
            shapes: {
                's1': { id: 's1', type: 'bezier-group', name: 'circle 1', bezierIds: ['b1'], style: { fill: '#2196F3' } },
                's2': { id: 's2', type: 'bezier-group', name: 'circle 2', bezierIds: ['b2'], style: { fill: '#2196F3' } },
                's_conn': { id: 's_conn', type: 'bezier-group', name: 'wrap 1', bezierIds: ['b_conn'], style: { fill: '#2196F3' } },
                'l1': { id: 'l1', type: 'layer', name: 'Layer 1', childIds: ['s1', 's2', 's_conn'] }
            },
            beziers: {
                'b1': {
                    id: 'b1',
                    generator: { type: 'arc', params: { x: 100, y: 100, r: 50, startAngle: 0, endAngle: 1.57 } },
                    controlPoints: [{v: {x: 100, y: 100}}], boundingBox: { x: 50, y: 50, w: 100, h: 100 }
                },
                'b2': {
                    id: 'b2',
                    generator: { type: 'arc', params: { x: 300, y: 300, r: 50, startAngle: 0, endAngle: 1.57 } },
                    controlPoints: [{v: {x: 300, y: 300}}], boundingBox: { x: 250, y: 250, w: 100, h: 100 }
                },
                'b_conn': {
                    id: 'b_conn',
                    generator: {
                        type: 'connector',
                        params: {
                            src1: { bezierId: 'b1', t: 0 },
                            src2: { bezierId: 'b2', t: 0 },
                            d1: 0.1, d2: 0.1
                        }
                    },
                    controlPoints: [{v: {x: 100, y: 100}}, {v: {x: 150, y: 150}}, {v: {x: 250, y: 250}}, {v: {x: 300, y: 300}}],
                    boundingBox: { x: 100, y: 100, w: 200, h: 200 }
                }
            },
            selectedShapeIds: ['s1', 's2', 's_conn']
        };

        sandbox.testStateA = testStateA;
        vm.runInContext("state.reset(testStateA); state.selectedLayerId = 'l1';", sandbox);
        vm.runInContext("handleCopy()", sandbox);
        vm.runInContext("handlePaste()", sandbox);

        const newShapes = Object.values(sandbox.state.shapes).filter(s => s.id !== 's1' && s.id !== 's2' && s.id !== 's_conn' && s.id !== 'l1');
        if (newShapes.length !== 3) {
            throw new Error(`Expected 3 new pasted shapes, got ${newShapes.length}`);
        }
        
        const pastedConn = newShapes.find(s => s.name === 'wrap 1');
        const pastedCircle1 = newShapes.find(s => s.name === 'circle 1');
        const pastedCircle2 = newShapes.find(s => s.name === 'circle 2');

        const pastedConnBez = sandbox.state.beziers[pastedConn.bezierIds[0]];
        if (pastedConnBez.generator.params.src1.bezierId !== pastedCircle1.bezierIds[0] ||
            pastedConnBez.generator.params.src2.bezierId !== pastedCircle2.bezierIds[0]) {
            throw new Error('Pasted connector does not map to pasted circles');
        }

        if (sandbox.state.anchoredShapeIds.length !== 3) {
            throw new Error(`Expected anchoredShapeIds length to be 3, got ${sandbox.state.anchoredShapeIds.length}`);
        }
        console.log('✅ test_node.js: Copy/Paste with valid connector mapping test passed!');

        // (b) コネクタ単体をコピーしようとしたとき、接続先がコピー対象外であるため自身もコピーされないことの検証
        const testStateB = {
            shapes: {
                'l1': { id: 'l1', type: 'layer', name: 'Layer 1', childIds: ['s1', 's2', 's_conn'] },
                's1': { id: 's1', type: 'bezier-group', name: 'circle 1', bezierIds: ['b1'] },
                's2': { id: 's2', type: 'bezier-group', name: 'circle 2', bezierIds: ['b2'] },
                's_conn': { id: 's_conn', type: 'bezier-group', name: 'wrap 1', bezierIds: ['b_conn'] }
            },
            beziers: {
                'b_conn': {
                    id: 'b_conn',
                    generator: {
                        type: 'connector',
                        params: {
                            src1: { bezierId: 'b1', t: 0 },
                            src2: { bezierId: 'b2', t: 0 }
                        }
                    }
                }
            },
            selectedShapeIds: ['s_conn']
        };
        sandbox.testStateB = testStateB;
        vm.runInContext("state.reset(testStateB); state.clipboard = null;", sandbox);
        vm.runInContext("handleCopy()", sandbox);
        if (sandbox.state.clipboard !== null) {
            throw new Error('Connector copy should be skipped because dependencies are not selected');
        }
        console.log('✅ test_node.js: Connection pruning on Copy test passed!');

        // (c) 結合バウンズに基づく移動・拡大縮小・回転のテスト
        const testStateC = {
            shapes: {
                's1': { id: 's1', type: 'bezier-group', name: 'circle 1', bezierIds: ['b1'] },
                's2': { id: 's2', type: 'bezier-group', name: 'circle 2', bezierIds: ['b2'] }
            },
            beziers: {
                'b1': {
                    id: 'b1',
                    generator: { type: 'arc', params: { x: 100, y: 100, r: 50, startAngle: 0, endAngle: 1.57 } },
                    controlPoints: [{v: {x: 100, y: 100}}], boundingBox: { x: 50, y: 50, w: 100, h: 100 }
                },
                'b2': {
                    id: 'b2',
                    generator: { type: 'arc', params: { x: 300, y: 300, r: 50, startAngle: 0, endAngle: 1.57 } },
                    controlPoints: [{v: {x: 300, y: 300}}], boundingBox: { x: 250, y: 250, w: 100, h: 100 }
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

        vm.runInContext("scaleShapes(state.selectedShapeIds, 2, 200, 200)", sandbox);
        const b1Scaled = sandbox.state.beziers['b1'].generator.params;
        const b2Scaled = sandbox.state.beziers['b2'].generator.params;

        if (b1Scaled.x !== 0 || b1Scaled.y !== 0 || b1Scaled.r !== 100) {
            throw new Error(`Circle A scale failed: expected x=0, y=0, r=100, got x=${b1Scaled.x}, y=${b1Scaled.y}, r=${b1Scaled.r}`);
        }
        if (b2Scaled.x !== 400 || b2Scaled.y !== 400 || b2Scaled.r !== 100) {
            throw new Error(`Circle B scale failed: expected x=400, y=400, r=100, got x=${b2Scaled.x}, y=${b2Scaled.y}, r=${b2Scaled.r}`);
        }
        console.log('✅ test_node.js: Pivot-centered scaling test passed!');

        // 回転テスト (90度回転)
        b1Scaled.x = 100; b1Scaled.y = 100; b1Scaled.r = 50;
        b2Scaled.x = 300; b2Scaled.y = 300; b2Scaled.r = 50;
        vm.runInContext("rotateShapes(state.selectedShapeIds, 90, 200, 200)", sandbox);
        if (Math.abs(b1Scaled.x - 300) > 1e-4 || Math.abs(b1Scaled.y - 100) > 1e-4) {
            throw new Error(`Circle A rotation failed: expected (300, 100), got (${b1Scaled.x}, ${b1Scaled.y})`);
        }
        console.log('✅ test_node.js: Pivot-centered rotation test passed!');

    } catch (err) {
        console.error('❌ test_node.js: Copy/Paste or Transform bounds test failed!', err);
        process.exit(1);
    }

    // --- 追加テスト4：サムネイル生成 & Blob 保存のテスト ---
    sandbox.state.currentDrawId = 'd_test';
    sandbox.state.drawingName = 'Test Save';
    
    // Mock DB
    let putCalled = false;
    let putData = null;
    sandbox.mockDb = {
        transaction: () => ({
            objectStore: () => ({
                put: async (data) => {
                    putCalled = true;
                    putData = data;
                }
            })
        })
    };
    vm.runInContext("db = mockDb;", sandbox);

    vm.runInContext("saveDrawing()", sandbox).then(() => {
        if (!putCalled) {
            console.error('❌ test_node.js: saveDrawing thumbnail Blob test failed! db.put was not called');
            process.exit(1);
        }
        if (putData.name !== 'Test Save') {
            console.error(`❌ test_node.js: saveDrawing thumbnail Blob test failed! Expected saved name to be 'Test Save', got ${putData.name}`);
            process.exit(1);
        }
        if (!(putData.preview instanceof sandbox.Blob)) {
            console.error('❌ test_node.js: saveDrawing thumbnail Blob test failed! Expected preview to be a Blob');
            process.exit(1);
        }
        console.log('✅ test_node.js: saveDrawing thumbnail Blob test passed!');

        // --- 新規追加テスト：preventDefaultとテクスチャロード、および非同期コマンド実行のテスト ---
        try {
            let preventDefaultCalled = false;
            sandbox.mockEvent = {
                ctrlKey: true,
                preventDefault: () => {
                    preventDefaultCalled = true;
                }
            };
            vm.runInContext("state.reset({ shapes: {}, beziers: {} });", sandbox);
            vm.runInContext("handleInputUpdate('keydown', 'z', mockEvent)", sandbox);
            if (!preventDefaultCalled) {
                throw new Error('preventDefault should be called on registered keyboard shortcuts');
            }
            console.log('✅ test_node.js: preventDefault on matching shortcuts test passed!');

            vm.runInContext("db = null;", sandbox);
            vm.runInContext("loadDrawingTexture('d_non_existent')", sandbox).then((tex) => {
                if (tex !== null) {
                    console.error('❌ test_node.js: loadDrawingTexture should resolve to null when db is null');
                    process.exit(1);
                }
                console.log('✅ test_node.js: loadDrawingTexture handles null db gracefully!');

                // (3) executeCommand (fillpattern / strokepattern) の非同期テスト
                const testShape = { id: 's_pattern2', type: 'bezier-group', bezierIds: [] };
                sandbox.state.reset({ shapes: { 's_pattern2': testShape }, beziers: {} });
                sandbox.state.selectedShapeIds = ['s_pattern2'];
                sandbox.state.webglTextures = {
                    'sample': {},
                    'brush_sample': {}
                };

                vm.runInContext("executeCommand('fillpattern sample')", sandbox);
                vm.runInContext("executeCommand('strokepattern brush_sample')", sandbox);

                setTimeout(() => {
                    try {
                        const updatedShape = sandbox.state.shapes['s_pattern2'];
                        if (!updatedShape.style || updatedShape.style.fillPattern !== 'sample') {
                            throw new Error('executeCommand("fillpattern sample") did not set fillPattern style asynchronously');
                        }
                        if (updatedShape.style.strokePattern !== 'brush_sample') {
                            throw new Error('executeCommand("strokepattern brush_sample") did not set strokePattern style asynchronously');
                        }
                        console.log('✅ test_node.js: executeCommand fillpattern/strokepattern async tests passed!');
                        process.exit(0);
                    } catch (e) {
                        console.error('❌ test_node.js: executeCommand async test failed!', e);
                        process.exit(1);
                    }
                }, 10);
            }).catch(err => {
                console.error('❌ test_node.js: loadDrawingTexture failed with exception', err);
                process.exit(1);
            });
        } catch (e) {
            console.error('❌ test_node.js: preventDefault or loadDrawingTexture test failed!', e);
            process.exit(1);
        }
    }).catch(err => {
        console.error('❌ test_node.js: saveDrawing thumbnail Blob test failed!', err);
        process.exit(1);
    });
} catch (err) {
    console.error('❌ test_node.js: N-Wrap test failed!', err);
    process.exit(1);
}
