/**
 * @file history.js
 * @description Manages drawing history states enabling Undo/Redo mechanisms.
 */

/**
 * Pushes the current drawing state (shapes, beziers, layers, selections) onto history stack.
 */
function pushHistory() {
    const current = JSON.stringify({
        shapes: state.shapes,
        beziers: state.beziers,
        scene: state.scene,
        anchoredShapeIds: state.anchoredShapeIds,
        focusedVertex: state.focusedVertex,
        selectedShapeIds: state.selectedShapeIds,
        selectedLayerId: state.selectedLayerId
    }, stateReplacer);
    if (state.historyIndex >= 0 && current === state.history[state.historyIndex]) return;
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push(current);
    state.historyIndex = state.history.length - 1;
}

/**
 * Restores the previous drawing state from the history stack (Undo).
 */
function undo() {
    if (state.historyIndex <= 0) return;
    state.historyIndex--;
    const data = JSON.parse(state.history[state.historyIndex]);
    state.shapes = data.shapes || data.entities || {};
    state.beziers = data.beziers;
    state.scene = data.scene;
    state.anchoredShapeIds = data.anchoredShapeIds || [];
    state.focusedVertex = data.focusedVertex || null;

    state.selectedShapeIds = (data.selectedShapeIds || []).filter(id => state.shapes[id]);
    state.selectedLayerId = data.selectedLayerId && state.shapes[data.selectedLayerId] ? data.selectedLayerId : null;

    resolveBezierDependencies();
    clearAllCaches();
    renderCanvas();
}

/**
 * Restores the next drawing state from the history stack (Redo).
 */
function redo() {
    if (state.historyIndex >= state.history.length - 1) return;
    state.historyIndex++;
    const data = JSON.parse(state.history[state.historyIndex]);
    state.shapes = data.shapes || data.entities || {};
    state.beziers = data.beziers;
    state.scene = data.scene;
    state.anchoredShapeIds = data.anchoredShapeIds || [];
    state.focusedVertex = data.focusedVertex || null;
    state.selectedShapeIds = (data.selectedShapeIds || []).filter(id => state.shapes[id]);
    state.selectedLayerId = data.selectedLayerId && state.shapes[data.selectedLayerId] ? data.selectedLayerId : null;

    resolveBezierDependencies();
    clearAllCaches();
    renderCanvas();
}

// FUTURE: Phase out 'window as any' and 'global.d.ts' in favor of standard ES Modules (export/import) as refactoring opportunities arise.
(window as any).pushHistory = pushHistory;
(window as any).undo = undo;
(window as any).redo = redo;

export {};


