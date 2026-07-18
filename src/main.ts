/**
 * @file main.ts
 * @description Entry point for MorphDraw. Binds top-level event listeners (pointer, window, keyboard, DOM) and initializes the IndexedDB store.
 */

import './mdmath';
import './webgl_renderer';
import './state';
import './db';
import './history';
import './renderer';
import './editor';
import './test';
import './style.css';

document.addEventListener('DOMContentLoaded', () => {
    initDB();
    initOffscreenCanvases();
    initEvents();
});

/**
 * Binds DOM elements actions, window resize triggers, pointer movements, and keyboard events onto editor handler pipelines.
 */
function initEvents() {
    document.body.onclick = (event) => {
        handleInputUpdate(event);
    };

    const svg = getDom('#guide-svg');
    const minimapCanvas = getDom('#minimap-canvas');

    svg.addEventListener('pointerdown', (e) => {
        const startPt = getMainCanvasSVGPoint();
        state.input.isPointerDown = true;
        state.input.dragStartOnSVG = startPt;
        handleInputUpdate_old('pointerdown');
        handleInputUpdate(e);
    });

    window.addEventListener('wheel', (event) => {
        state.input.modifier = getModifierState(event);
        state.input.deltaY = event.deltaY;
        handleInputUpdate(event);
        event.preventDefault();
    }, { passive: false });

    if (minimapCanvas) {
        minimapCanvas.addEventListener('pointerdown', (e) => {
            state.input.isPointerDown = true;
            const pt = getMainCanvasSVGPoint();
            state.input.dragStartOnSVG = pt;
            handleInputUpdate_old('pointerdown');
            handleInputUpdate(e);
        });
    }

    window.addEventListener('pointermove', (e) => {
        if (state.view === 'canvas') {
            state.input.dPointer = { x: e.clientX - state.input.pointer.x, y: e.clientY - state.input.pointer.y };
            state.input.pointer = { x: e.clientX, y: e.clientY };

            const pt = getMainCanvasSVGPoint();
            state.input.pointerOnSVG = { x: pt.x, y: pt.y };

            handleInputUpdate_old('pointermove');
            handleInputUpdate(e);
        }
    });

    const stop = (e) => {
        state.input.isPointerDown = false;
        state.input.dragStartOnSVG = null;
        handleInputUpdate_old('pointerup');
        handleInputUpdate(e);
    };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);

    window.addEventListener('keydown', async e => {
        if (e.repeat) return;
        if (isFocusEditable()) return;
        state.input.keys[e.key] = true;
        await handleInputUpdate_old('keydown', e.key, e);
        await handleInputUpdate(e);
    });

    window.addEventListener('keyup', async e => {
        if (isFocusEditable()) return;
        state.input.keys[e.key] = false;
        await handleInputUpdate_old('keyup', e.key, e);
        await handleInputUpdate(e);
    });


    const dlSlider = getDom('#slider-deform-dl');
    if (dlSlider) {
        dlSlider.oninput = () => {
            const val = parseInt(dlSlider.value, 10);
            state.deformSettings.dl = val;
            const label = getDom('#val-deform-dl');
            if (label) label.textContent = String(val);
        };
        dlSlider.onchange = () => {
            saveDrawing();
        };
    }

    const searchInput = getDom('#search-input');
    if (searchInput) {
        searchInput.oninput = () => {
            performSearch(searchInput.value);
            applySearchResult();
        };
        searchInput.onkeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                closeSearchMode(true);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeSearchMode(false);
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (state.search.results.length > 0) {
                    state.search.currentIndex = (state.search.currentIndex + 1) % state.search.results.length;
                    applySearchResult();
                }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (state.search.results.length > 0) {
                    state.search.currentIndex = (state.search.currentIndex - 1 + state.search.results.length) % state.search.results.length;
                    applySearchResult();
                }
            }
        };
        searchInput.onblur = () => {
            setTimeout(() => {
                if (state.search.active) {
                    closeSearchMode(true);
                }
            }, 200);
        };
    }

    const commandInput = getDom('#command-input');
    if (commandInput) {
        commandInput.onkeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                closeCommandMode(true);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeCommandMode(false);
            }
        };
        commandInput.onblur = () => {
            setTimeout(() => {
                if (state.command.active) {
                    closeCommandMode(false);
                }
            }, 200);
        };
    }

    if (svg) registerHoverListener(svg);
    if (minimapCanvas) registerHoverListener(minimapCanvas);
}

/**
 * Registers mouseenter and mouseleave event listeners to track which canvas/SVG element the user is hovering over.
 * @param {Element} elm - The target DOM element.
 */
function registerHoverListener(elm) {
    elm.addEventListener('mouseenter', () => {
        state.input.hoverOn = elm.id;
    });
    elm.addEventListener('mouseleave', () => {
        state.input.hoverOn = '';
    });
}
