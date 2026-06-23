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

// ブラウザ環境のモックコンテキストを作成
const sandbox = {
    // 最小限のグローバルオブジェクトとブラウザAPIのモック
    crypto: {
        randomUUID: () => 'test-uuid-1234'
    },
    document: {
        addEventListener: () => {},
        getElementById: () => ({
            onclick: null,
            addEventListener: () => {}
        }),
        createElement: () => ({
            width: 0,
            height: 0,
            getContext: () => ({
                clearRect: () => {},
                save: () => {},
                restore: () => {},
                translate: () => {},
                scale: () => {},
                rotate: () => {},
                drawImage: () => {}
            })
        })
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
    process.exit(0);
} else {
    console.error('❌ test_node.js: handleMove test failed!');
    console.error(`Expected generator x: ${expectedX}, y: ${expectedY}`);
    console.error(`Got generator x: ${bez.generator.params.x}, y: ${bez.generator.params.y}`);
    process.exit(1);
}
