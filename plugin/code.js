"use strict";
// Asseter — inserts published library components by name.
// The index of available components is hosted as JSON (see ui.html CONFIG).
//
// This file runs in the plugin sandbox and has access to the Figma document.
// All network requests happen in ui.html (iframe).
figma.showUI(__html__, { width: 400, height: 560, themeColors: true });
// Thumbnails are split across shard files so no single hosted file grows huge.
const SHARD_SIZE = 25;
// 96px keeps cards crisp while roughly halving the index: 128px put the
// preview payload over Figma's ~5 MB clientStorage budget, so almost nothing
// stayed cached and every run re-downloaded everything.
const THUMB_WIDTH = 96;
// A leading underscore marks a component as retired: it stays published so
// existing instances keep working, but the plugin does not offer it.
const HIDDEN_PREFIX = '_';
function isHidden(name) {
    return name.split('/').some((segment) => segment.trim().indexOf(HIDDEN_PREFIX) === 0);
}
// ---------------------------------------------------------------------------
// Drag & drop from the plugin window onto the canvas
// ---------------------------------------------------------------------------
figma.on('drop', (event) => {
    for (const item of event.items) {
        if (item.type !== 'application/x-asseter')
            continue;
        let payload;
        try {
            payload = JSON.parse(item.data);
        }
        catch {
            continue;
        }
        // A card can carry both sides of one coin, so the payload is a list. The
        // single-asset shape is still accepted for older UI builds.
        const items = payload.items && payload.items.length
            ? payload.items
            : (payload.key ? [{ key: payload.key, name: payload.name || '' }] : []);
        if (items.length === 0)
            continue;
        void insertBatch(items, event.absoluteX, event.absoluteY);
    }
    return false;
});
figma.ui.onmessage = async (msg) => {
    switch (msg.type) {
        case 'insert-batch':
            await insertBatch(msg.items);
            break;
        case 'build-index':
            await buildIndex();
            break;
        case 'cache-get':
            await cacheGet(msg.requestId, msg.key);
            break;
        case 'cache-set':
            await cacheSet(msg.key, msg.value);
            break;
        case 'cache-delete':
            await cacheDelete(msg.key);
            break;
        case 'cache-prune':
            await cachePrune(msg.keepPrefix);
            break;
        case 'notify':
            figma.notify(msg.message, { error: msg.error === true });
            break;
        case 'resize':
            figma.ui.resize(msg.width, msg.height);
            break;
    }
};
// ---------------------------------------------------------------------------
// Thumbnail cache (clientStorage lives in the sandbox, not the iframe)
// ---------------------------------------------------------------------------
async function cacheGet(requestId, key) {
    let value = null;
    try {
        value = await figma.clientStorage.getAsync(key);
    }
    catch {
        value = null;
    }
    figma.ui.postMessage({ type: 'cache-value', requestId, value: value === undefined ? null : value });
}
async function cacheSet(key, value) {
    try {
        await figma.clientStorage.setAsync(key, value);
    }
    catch {
        // Quota exceeded — cache is an optimisation, ignore failures.
    }
}
async function cacheDelete(key) {
    try {
        await figma.clientStorage.deleteAsync(key);
    }
    catch {
        // Ignore.
    }
}
async function cachePrune(keepPrefix) {
    try {
        const keys = await figma.clientStorage.keysAsync();
        for (const key of keys) {
            if (key.indexOf('thumbs:') === 0 && key.indexOf(keepPrefix) !== 0) {
                await figma.clientStorage.deleteAsync(key);
            }
        }
    }
    catch {
        // Ignore.
    }
}
// ---------------------------------------------------------------------------
// Insertion
// ---------------------------------------------------------------------------
const GRID_GAP = 40;
const GRID_MAX_COLS = 5;
function measure(nodes) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
        const box = node.absoluteBoundingBox;
        if (!box)
            continue;
        minX = Math.min(minX, box.x);
        minY = Math.min(minY, box.y);
        maxX = Math.max(maxX, box.x + box.width);
        maxY = Math.max(maxY, box.y + box.height);
    }
    if (minX === Infinity)
        return { nodes, x: 0, y: 0, w: 0, h: 0 };
    return { nodes, x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
function moveUnit(unit, x, y) {
    const dx = x - unit.x;
    const dy = y - unit.y;
    // Translating by a delta is rotation-safe; assigning x/y is not, because a
    // rotated node reports its pre-rotation origin there.
    for (const node of unit.nodes) {
        node.x += dx;
        node.y += dy;
    }
    unit.x = x;
    unit.y = y;
}
// Library components are contact sheets: a padded frame holding the asset's
// photos. Detaching leaves that frame on the canvas and the images have to be
// dug out of it, so the children are lifted onto the page and the wrapper is
// dropped. A frame with no children is the artwork itself and stays.
function unwrap(frame) {
    const parent = frame.parent;
    const children = frame.children.slice();
    if (!parent || children.length === 0)
        return [frame];
    const at = parent.children.indexOf(frame);
    const lifted = [];
    children.forEach((child, i) => {
        const before = child.absoluteBoundingBox;
        parent.insertChild(at + i, child);
        const after = child.absoluteBoundingBox;
        if (before && after) {
            child.x += before.x - after.x;
            child.y += before.y - after.y;
        }
        lifted.push(child);
    });
    frame.remove();
    return lifted;
}
function layOutGrid(units, anchorX, anchorY) {
    const cols = Math.min(GRID_MAX_COLS, Math.ceil(Math.sqrt(units.length)));
    const rows = [];
    for (let i = 0; i < units.length; i += cols)
        rows.push(units.slice(i, i + cols));
    const rowWidths = rows.map((row) => row.reduce((sum, u) => sum + u.w, 0) + GRID_GAP * (row.length - 1));
    const rowHeights = rows.map((row) => Math.max(...row.map((u) => u.h)));
    const totalW = Math.max(...rowWidths);
    const totalH = rowHeights.reduce((sum, h) => sum + h, 0) + GRID_GAP * (rows.length - 1);
    const originX = anchorX !== undefined ? anchorX : figma.viewport.center.x - totalW / 2;
    const originY = anchorY !== undefined ? anchorY : figma.viewport.center.y - totalH / 2;
    let y = originY;
    rows.forEach((row, r) => {
        let x = originX;
        for (const unit of row) {
            moveUnit(unit, Math.round(x), Math.round(y + (rowHeights[r] - unit.h) / 2));
            x += unit.w + GRID_GAP;
        }
        y += rowHeights[r] + GRID_GAP;
    });
}
async function insertBatch(items, dropX, dropY) {
    const inserted = [];
    const failed = [];
    for (const item of items) {
        try {
            const component = await figma.importComponentByKeyAsync(item.key);
            const instance = component.createInstance();
            figma.currentPage.appendChild(instance);
            // Always detached: detachInstance() cuts the library link and returns a
            // plain frame. Nested instances inside stay instances — Figma detaches
            // one level only.
            const detached = instance.detachInstance();
            inserted.push(measure(unwrap(detached)));
        }
        catch {
            failed.push(item.name);
        }
    }
    if (failed.length > 0) {
        const head = failed.slice(0, 3).join(', ');
        figma.notify(`Failed to insert (${failed.length}): ${head}${failed.length > 3 ? '…' : ''}. Is the library published?`, { error: true });
    }
    if (inserted.length > 0) {
        layOutGrid(inserted, dropX, dropY);
        const nodes = [];
        for (const unit of inserted)
            for (const node of unit.nodes)
                nodes.push(node);
        figma.currentPage.selection = nodes;
        if (dropX === undefined) {
            figma.viewport.scrollAndZoomIntoView(nodes);
        }
        figma.notify(`Inserted: ${inserted.length}`);
    }
    figma.ui.postMessage({ type: 'insert-done' });
}
// The photos inside a coin component are named like
// "1 Centavo_Argentina_1880_$12,500_A 2" — the mint year and the price live
// there and nowhere else, so the index lifts them out of the layer names.
const YEAR_RE = /(?:^|[^0-9])((?:1[0-9]|20)[0-9]{2})(?![0-9])/g;
const PRICE_RE = /([$€£¥₣])\s*([0-9][0-9.,]*)\s*(million|billion|m|bn)?/gi;
function yearsIn(text) {
    const out = [];
    let m;
    YEAR_RE.lastIndex = 0;
    while ((m = YEAR_RE.exec(text)) !== null) {
        const year = Number(m[1]);
        if (year >= 1000 && year <= 2099 && out.indexOf(year) === -1)
            out.push(year);
    }
    return out;
}
function pricesIn(text) {
    const out = [];
    let m;
    PRICE_RE.lastIndex = 0;
    while ((m = PRICE_RE.exec(text)) !== null) {
        // "12,500" is twelve thousand five hundred; "924.87" is not.
        const digits = m[2].replace(/,/g, '');
        let value = Number(digits);
        if (isNaN(value))
            continue;
        const scale = (m[3] || '').toLowerCase();
        if (scale === 'million' || scale === 'm')
            value *= 1e6;
        else if (scale === 'billion' || scale === 'bn')
            value *= 1e9;
        if (out.indexOf(value) === -1)
            out.push(value);
    }
    return out;
}
// Layer names of every photo inside the component, however deeply nested.
function layerNames(node) {
    const out = [];
    const walk = (n) => {
        out.push(n.name);
        if ('children' in n)
            for (const kid of n.children)
                walk(kid);
    };
    if ('children' in node)
        for (const kid of node.children)
            walk(kid);
    return out;
}
// "Rock/Agate" and "Zodiac / Sign=Aries" both split on "/" regardless of spaces.
function categoryOf(name) {
    const i = name.indexOf('/');
    return i === -1 ? '' : name.slice(0, i).trim();
}
async function buildIndex() {
    figma.notify('Indexing… large files may take a minute', { timeout: 2000 });
    await figma.loadAllPagesAsync();
    const components = figma.root.findAllWithCriteria({ types: ['COMPONENT'] });
    if (components.length === 0) {
        figma.ui.postMessage({
            type: 'index-error',
            message: 'No components in this file. Build the index inside the library file.',
        });
        return;
    }
    const assets = [];
    const thumbs = [];
    let failed = 0;
    let hidden = 0;
    for (const component of components) {
        const name = component.parent && component.parent.type === 'COMPONENT_SET'
            ? `${component.parent.name} / ${component.name}`
            : component.name;
        // Retired components stay published but are kept out of the index.
        if (isHidden(name)) {
            hidden += 1;
            continue;
        }
        try {
            const png = await component.exportAsync({
                format: 'PNG',
                constraint: { type: 'WIDTH', value: THUMB_WIDTH },
            });
            const text = layerNames(component).join(' | ');
            const years = yearsIn(text);
            const prices = pricesIn(text);
            const asset = {
                name,
                key: component.key,
                w: Math.round(component.width),
                h: Math.round(component.height),
                cat: categoryOf(name),
            };
            if (years.length > 0)
                asset.y = years.sort((a, b) => a - b);
            if (prices.length > 0)
                asset.c = prices.sort((a, b) => a - b);
            assets.push(asset);
            thumbs.push({ key: component.key, thumb: figma.base64Encode(png) });
            figma.ui.postMessage({ type: 'index-progress', done: assets.length, total: components.length - hidden });
        }
        catch {
            failed += 1;
        }
    }
    if (assets.length === 0) {
        figma.ui.postMessage({
            type: 'index-error',
            message: `All ${hidden} components are hidden (name starts with “_”).`,
        });
        return;
    }
    // Split thumbnails into shard files so each hosted file stays small.
    const shardCount = Math.max(1, Math.ceil(thumbs.length / SHARD_SIZE));
    const rev = new Date().toISOString();
    const thumbFiles = [];
    const shards = [];
    for (let i = 0; i < shardCount; i++) {
        const filename = `asseter-thumbs-${i + 1}.json`;
        thumbFiles.push(filename);
        const map = {};
        for (const entry of thumbs.slice(i * SHARD_SIZE, (i + 1) * SHARD_SIZE)) {
            map[entry.key] = entry.thumb;
        }
        shards.push({ filename, data: { v: 2, rev, thumbs: map } });
    }
    figma.ui.postMessage({
        type: 'index-built',
        failed,
        hidden,
        meta: {
            filename: 'asseter-index.json',
            data: {
                v: 4,
                rev,
                generatedAt: rev,
                fileName: figma.root.name,
                thumbFiles,
                assets,
            },
        },
        shards,
    });
}
