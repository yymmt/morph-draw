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
    style: {},
    classList: {
        toggle: () => {},
        add: () => {},
        remove: () => {}
    },
    addEventListener: () => {},
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
    vm.runInContext("globalThis.state = state;", sandbox);
} catch (err) {
    console.error('❌ Failed to load main.js in test context:', err);
    process.exit(1);
}

// sandboxからテスト対象のオブジェクトと関数を取り出す
const state = sandbox.state;

console.log('--- Running MorphDraw Node tests ---');

try {
    // 1. 初期状態のリセット
    vm.runInContext("state.reset({ shapes: {}, beziers: {}, layers: {}, scene: [] });", sandbox);
    
    // ダミーレイヤーの作成
    const layerId = 'l_test';
    state.layers[layerId] = {
        id: layerId,
        type: 'layer',
        name: 'Layer 1',
        childIds: [],
        visible: true,
        locked: false
    };
    state.scene = [layerId];
    state.selectedLayerId = layerId;

    // 2. addShapeAt テスト
    vm.runInContext("addShapeAt('circle', 100, 100);", sandbox);
    const circleShape = Object.values(state.shapes).find(s => s.type === 'circle');
    if (!circleShape) {
        throw new Error('addShapeAt did not create a circle shape');
    }
    if (circleShape.props.x !== 100 || circleShape.props.y !== 100 || circleShape.props.r !== 50) {
        throw new Error(`Invalid initial props: ${JSON.stringify(circleShape.props)}`);
    }
    console.log('✅ addShapeAt test passed!');
    state.selectedShapeIds = [circleShape.id];

    // 3. moveShapes テスト
    vm.runInContext("moveShapes(state.selectedShapeIds, 20, -10);", sandbox);
    if (circleShape.props.x !== 120 || circleShape.props.y !== 90) {
        throw new Error(`moveShapes failed. Got props: ${JSON.stringify(circleShape.props)}`);
    }
    console.log('✅ moveShapes test passed!');

    // 4. scaleShapes テスト
    vm.runInContext("state.transformPivotMode = 'individual';", sandbox);
    vm.runInContext("scaleShapes([state.selectedShapeIds[0]], 2.0, 120, 90);", sandbox);
    if (circleShape.props.r !== 100) {
        throw new Error(`scaleShapes (individual) failed. Radius: ${circleShape.props.r}`);
    }

    vm.runInContext("state.transformPivotMode = 'combined';", sandbox);
    vm.runInContext("scaleShapes([state.selectedShapeIds[0]], 0.5, 0, 0);", sandbox);
    // (120, 90) * 0.5 = (60, 45), r=100 * 0.5 = 50
    if (circleShape.props.x !== 60 || circleShape.props.y !== 45 || circleShape.props.r !== 50) {
        throw new Error(`scaleShapes (combined) failed. Got props: ${JSON.stringify(circleShape.props)}`);
    }
    console.log('✅ scaleShapes test passed!');

    // 5. rotateShapes テスト
    vm.runInContext("state.transformPivotMode = 'combined';", sandbox);
    vm.runInContext("rotateShapes([state.selectedShapeIds[0]], 90, 0, 0);", sandbox);
    // (60, 45) を原点中心に90度回転 => (-45, 60)
    if (Math.abs(circleShape.props.x - (-45)) > 1e-4 || Math.abs(circleShape.props.y - 60) > 1e-4) {
        throw new Error(`rotateShapes failed. Got props: ${JSON.stringify(circleShape.props)}`);
    }
    console.log('✅ rotateShapes test passed!');

    // 6. コネクター生成 (createWrap) テスト
    // 新たにもう一つの円を追加して wrap する
    vm.runInContext("addShapeAt('circle', 200, 200);", sandbox);
    const shapes = Object.keys(state.shapes).filter(id => state.shapes[id].type === 'circle');
    state.selectedShapeIds = [shapes[0], shapes[1]];
    
    vm.runInContext("createWrap();", sandbox);
    const wrapShape = Object.values(state.shapes).find(s => s.type === 'wrap');
    if (!wrapShape) {
        throw new Error('createWrap did not create a wrap shape');
    }
    if (wrapShape.bezierIds.length !== 4) {
        throw new Error(`wrap should have 4 connector beziers, got ${wrapShape.bezierIds.length}`);
    }
    console.log('✅ createWrap test passed!');

    // 7. resolveBezierDependencies テスト
    vm.runInContext("resolveBezierDependencies();", sandbox);
    const c1 = state.beziers[wrapShape.bezierIds[0]].controlPoints;
    if (!c1 || c1.length < 4) {
        throw new Error('Bezier controlPoints resolution failed');
    }
    console.log('✅ resolveBezierDependencies test passed!');

    console.log('🎉 All MorphDraw tests passed successfully!');
    process.exit(0);

} catch (err) {
    console.error('❌ Test execution failed:', err);
    process.exit(1);
}
