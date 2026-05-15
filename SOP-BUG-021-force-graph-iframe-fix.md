# SOP: Force-Graph Iframe Rendering Fix (BUG-021)

**Date**: December 19, 2025
**Status**: RESOLVED
**Commit**: `c45c207`

---

## Problem Statement

Skills and Docs tabs in dev-manager showed black/empty canvas or only rendered edge lines (no nodes) when:
1. First clicking on Skills or Docs tabs
2. Switching between tabs multiple times

## Root Cause Analysis

### Issue 1: Zero-Dimension Container
Force-graph library requires a container with visible dimensions. When iframes loaded immediately with hidden tabs (`display: none`), the canvas initialized with zero dimensions.

### Issue 2: Chromium Canvas Bug
Known Chromium bug ([Issue #40459316](https://issues.chromium.org/issues/40459316)) where canvas content disappears after tab switches.

### Issue 3: State Corruption from Repeated Resize
Repeatedly calling `graph.width()` and `graph.height()` on tab switches caused progressive state corruption ([Issue #230](https://github.com/vasturiano/force-graph/issues/230)).

---

## Solution

### 1. Lazy Loading Iframes (`dev-manager/index.html`)

Changed iframes from immediate loading to lazy loading:

```html
<!-- Before: Loaded immediately -->
<iframe src="skills/index.html" title="Skills Dashboard"></iframe>

<!-- After: Lazy loaded on first tab activation -->
<iframe data-src="skills/index.html" title="Skills Dashboard"></iframe>
```

Tab switch logic sets `src` only on first activation:

```javascript
if (iframe.dataset.src && !iframe.src) {
    iframe.src = iframe.dataset.src;
} else if (iframe.contentWindow) {
    iframe.contentWindow.postMessage({ type: 'tab-activated' }, '*');
}
```

### 2. Single Setup + Pause/Resume Refresh (`skills/docs index.html`)

```javascript
// Track if initial setup is done
let isInitialized = false;

// Initial setup - only runs once
function setupGraph() {
    if (!graph || isInitialized) return;
    const rect = container.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
        graph.width(rect.width);
        graph.height(rect.height);
        isInitialized = true;
    }
}

// Refresh on tab switch - uses pause/resume instead of resize
function refreshGraph() {
    if (!graph) return;
    graph.pauseAnimation();
    requestAnimationFrame(() => {
        if (graph) graph.resumeAnimation();
    });
}

// Listen for tab activation
window.addEventListener('message', (event) => {
    if (event.data?.type === 'tab-activated') {
        refreshGraph();
    }
});
```

---

## Files Modified

| File | Changes |
|------|---------|
| `dev-manager/index.html` | Lines 194-200 (lazy iframe markup), 233-244 (switchTab logic) |
| `dev-manager/skills/index.html` | Lines 634-682 (setupGraph, refreshGraph, message listener) |
| `dev-manager/docs/index.html` | Lines 659-706 (setupGraph, refreshGraph, message listener) |

---

## Key Learnings

1. **Force-graph requires visible container** - Canvas dimensions must be non-zero at initialization
2. **Chromium canvas bug exists** - Tab switches can cause canvas to go blank
3. **Avoid repeated resize calls** - Use `pauseAnimation()`/`resumeAnimation()` cycle instead
4. **Lazy loading iframes** - `data-src` pattern ensures content loads when visible

---

## Testing Checklist

- [x] Skills tab renders on first click
- [x] Docs tab renders on first click
- [x] Switching between tabs multiple times works
- [x] Nodes and labels visible (not just edges)
- [x] Graph interaction (hover, click) works after tab switches

---

## Rollback Command

```bash
git revert c45c207
```

---

## References

- [force-graph GitHub](https://github.com/vasturiano/force-graph)
- [Chromium Canvas Bug #40459316](https://issues.chromium.org/issues/40459316)
- [Force-graph Clean Redraw Issue #230](https://github.com/vasturiano/force-graph/issues/230)
- [React Force Graph Responsive Width #233](https://github.com/vasturiano/react-force-graph/issues/233)
