const fs = require('fs');
const vm = require('vm');
const path = require('path');

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
        const w0 = vm.runInContext("getShapeThickness(state.shapes['s_test'], 0.0)", sandbox);
        const w025 = vm.runInContext("getShapeThickness(state.shapes['s_test'], 0.25)", sandbox);
        const w05 = vm.runInContext("getShapeThickness(state.shapes['s_test'], 0.5)", sandbox);
        const w1 = vm.runInContext("getShapeThickness(state.shapes['s_test'], 1.0)", sandbox);

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

    process.exit(0);
} catch (err) {
    console.error('❌ test_node.js: N-Wrap test failed!', err);
    process.exit(1);
}
