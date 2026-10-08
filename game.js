(() => {
  'use strict';

  const field = document.querySelector('#field');
  const landing = document.querySelector('#landing');
  const selectionBox = document.querySelector('#selection-box');
  const columns = Number(field.dataset.columns);
  const rows = Number(field.dataset.rows);
  let cubes = [...field.querySelectorAll('.cube')].map(element => ({
    element,
    name: element.getAttribute('aria-label'),
    source: element.id,
    width: Number(element.dataset.width || element.dataset.size),
    height: Number(element.dataset.height || element.dataset.size),
    position: { column: Number(element.dataset.column), row: Number(element.dataset.row) },
  }));
  let drag = null;
  let selection = null;
  let fragmentId = 0;

  field.style.setProperty('--columns', columns);
  field.style.setProperty('--rows', rows);

  function render() {
    for (const cube of cubes) {
      const active = drag?.cube === cube;
      const visual = active ? drag.visual : cube.position;
      const target = active ? drag.target : cube.position;
      cube.element.style.left = `${visual.column / columns * 100}%`;
      cube.element.style.top = `${visual.row / rows * 100}%`;
      cube.element.style.setProperty('--cube-width', cube.width);
      cube.element.style.setProperty('--cube-height', cube.height);
      cube.element.dataset.width = cube.width;
      cube.element.dataset.height = cube.height;
      cube.element.dataset.source = cube.source;
      if (cube.width === cube.height) cube.element.dataset.size = cube.width;
      else delete cube.element.dataset.size;
      cube.element.dataset.column = target.column;
      cube.element.dataset.row = target.row;
      cube.element.dataset.dragging = String(active);
      cube.element.dataset.selected = String(Boolean(cube.selected));
      cube.element.setAttribute('aria-pressed', String(Boolean(cube.selected)));
      cube.element.setAttribute('aria-label', `${cube.name} ${cube.width} на ${cube.height} ячейки. Столбец ${target.column + 1}, строка ${target.row + 1}.`);
    }
    landing.hidden = drag === null;
    if (drag) {
      landing.style.left = `${drag.target.column / columns * 100}%`;
      landing.style.top = `${drag.target.row / rows * 100}%`;
    }
    selectionBox.hidden = selection === null;
    if (selection) {
      const { start, end } = selection;
      selectionBox.style.left = `${Math.min(start.column, end.column) / columns * 100}%`;
      selectionBox.style.top = `${Math.min(start.row, end.row) / rows * 100}%`;
      selectionBox.style.width = `${Math.abs(start.column - end.column) / columns * 100}%`;
      selectionBox.style.height = `${Math.abs(start.row - end.row) / rows * 100}%`;
    }
  }

  function snapped(cube, column, row) {
    return {
      column: Math.max(0, Math.min(columns - cube.width, Math.round(column))),
      row: Math.max(0, Math.min(rows - cube.height, Math.round(row))),
    };
  }

  function canPlace(cube, target) {
    return cubes.every(other => other === cube ||
      target.column + cube.width <= other.position.column ||
      target.column >= other.position.column + other.width ||
      target.row + cube.height <= other.position.row ||
      target.row >= other.position.row + other.height);
  }

  function move(cube, column, row) {
    const target = snapped(cube, column, row);
    if (canPlace(cube, target) &&
      (target.column !== cube.position.column || target.row !== cube.position.row)) {
      Object.assign(cube.position, target);
      clearLines();
    }
    render();
  }

  function nearestAvailable(cube, visual, preferred) {
    // Retain equal-distance choices and ignore subpixel pointer-coordinate rounding.
    let nearest = preferred;
    let distance = (nearest.column - visual.column) ** 2 + (nearest.row - visual.row) ** 2;
    for (let row = 0; row <= rows - cube.height; row++) {
      for (let column = 0; column <= columns - cube.width; column++) {
        const candidateDistance = (column - visual.column) ** 2 + (row - visual.row) ** 2;
        if (candidateDistance >= distance - 0.005) continue;
        const candidate = { column, row };
        if (!canPlace(cube, candidate)) continue;
        nearest = candidate;
        distance = candidateDistance;
      }
    }
    return nearest;
  }

  function remainingSpans(start, length, removed) {
    const spans = [];
    for (let cell = start; cell < start + length; cell++) {
      if (removed.has(cell)) continue;
      const last = spans[spans.length - 1];
      if (last && last.start + last.length === cell) last.length++;
      else spans.push({ start: cell, length: 1 });
    }
    return spans;
  }

  function flashLines(fullRows, fullColumns) {
    for (const [axis, lines] of [['row', fullRows], ['column', fullColumns]]) {
      for (const line of lines) {
        const flash = document.createElement('div');
        flash.className = 'line-clear';
        flash.setAttribute('aria-hidden', 'true');
        flash.style.left = `${axis === 'column' ? line / columns * 100 : 0}%`;
        flash.style.top = `${axis === 'row' ? line / rows * 100 : 0}%`;
        flash.style.width = `${axis === 'column' ? 100 / columns : 100}%`;
        flash.style.height = `${axis === 'row' ? 100 / rows : 100}%`;
        field.append(flash);
        setTimeout(() => flash.remove(), 260);
      }
    }
  }

  function clearLines() {
    const rowCounts = Array(rows).fill(0);
    const columnCounts = Array(columns).fill(0);
    for (const cube of cubes) {
      for (let row = cube.position.row; row < cube.position.row + cube.height; row++) rowCounts[row] += cube.width;
      for (let column = cube.position.column; column < cube.position.column + cube.width; column++) columnCounts[column] += cube.height;
    }
    // Find both directions before removing anything, including their intersections.
    const fullRows = new Set(rowCounts.flatMap((count, row) => count === columns ? [row] : []));
    const fullColumns = new Set(columnCounts.flatMap((count, column) => count === rows ? [column] : []));
    if (!fullRows.size && !fullColumns.size) return;

    const survivors = [];
    const focused = document.activeElement;
    let focusReplacement = null;
    for (const cube of cubes) {
      const horizontal = remainingSpans(cube.position.column, cube.width, fullColumns);
      const vertical = remainingSpans(cube.position.row, cube.height, fullRows);
      // Cutting whole rows and columns of a rectangle always leaves separate rectangles.
      const fragments = vertical.flatMap(y => horizontal.map(x => ({
        width: x.length, height: y.length,
        position: { column: x.start, row: y.start },
      })));
      // Clone before altering the original, retaining its colour and visual style.
      const template = cube.element.cloneNode(false);
      fragments.forEach((fragment, index) => {
        if (index === 0) {
          Object.assign(cube, fragment);
          survivors.push(cube);
        } else {
          const element = template.cloneNode(false);
          element.id = `${cube.source}-part-${++fragmentId}`;
          const part = { ...cube, ...fragment, element };
          connect(part);
          field.append(element);
          survivors.push(part);
        }
      });
      if (!fragments.length) {
        cube.element.remove();
        if (focused === cube.element) focusReplacement = true;
      }
    }
    cubes = survivors;
    render();
    flashLines(fullRows, fullColumns);
    if (focusReplacement && cubes.length) cubes[0].element.focus({ preventScroll: true });
  }

  function pointerCell(event) {
    const bounds = field.getBoundingClientRect();
    return {
      column: (event.clientX - bounds.left) / bounds.width * columns,
      row: (event.clientY - bounds.top) / bounds.height * rows,
    };
  }

  function follow(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const point = pointerCell(event);
    drag.visual = {
      column: Math.max(0, Math.min(columns - drag.cube.width, point.column - drag.offset.column)),
      row: Math.max(0, Math.min(rows - drag.cube.height, point.row - drag.offset.row)),
    };
    drag.target = nearestAvailable(drag.cube, drag.visual, drag.target);
    render();
  }

  function followSelection(event) {
    if (!selection || event.pointerId !== selection.id) return;
    const point = pointerCell(event);
    selection.end = {
      column: Math.max(0, Math.min(columns, point.column)),
      row: Math.max(0, Math.min(rows, point.row)),
    };
    const left = Math.min(selection.start.column, selection.end.column);
    const right = Math.max(selection.start.column, selection.end.column);
    const top = Math.min(selection.start.row, selection.end.row);
    const bottom = Math.max(selection.start.row, selection.end.row);
    for (const cube of cubes) {
      cube.selected = right > left && bottom > top &&
        cube.position.column < right && cube.position.column + cube.width > left &&
        cube.position.row < bottom && cube.position.row + cube.height > top;
    }
    render();
  }

  function finishSelection(cancelled) {
    if (!selection) return;
    const previous = selection;
    selection = null;
    if (cancelled) for (const cube of cubes) cube.selected = previous.selected.has(cube);
    if (field.hasPointerCapture(previous.id)) field.releasePointerCapture(previous.id);
    render();
  }

  function cancelGestures() {
    finish(true);
    finishSelection(true);
  }

  function finish(cancelled) {
    if (!drag) return;
    const previous = drag;
    drag = null;
    Object.assign(previous.cube.position, cancelled ? previous.origin : previous.target);
    if (previous.cube.element.hasPointerCapture(previous.id)) previous.cube.element.releasePointerCapture(previous.id);
    if (!cancelled) clearLines();
    render();
  }

  function connect(cube) {
    const element = cube.element;
    element.addEventListener('pointerdown', event => {
      if (drag || selection || !event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      const point = pointerCell(event);
      drag = {
        cube,
        id: event.pointerId,
        origin: { ...cube.position },
        visual: { ...cube.position },
        target: { ...cube.position },
        offset: { column: point.column - cube.position.column, row: point.row - cube.position.row },
      };
      landing.style.setProperty('--cube-width', cube.width);
      landing.style.setProperty('--cube-height', cube.height);
      landing.style.setProperty('--preview-color', getComputedStyle(element).getPropertyValue('--landing-color'));
      element.setPointerCapture(event.pointerId);
      render();
    });
    element.addEventListener('pointermove', follow);
    element.addEventListener('pointerup', event => {
      if (!drag || event.pointerId !== drag.id) return;
      follow(event);
      finish(false);
    });
    element.addEventListener('pointercancel', event => {
      if (drag?.id === event.pointerId) finish(true);
    });
    element.addEventListener('lostpointercapture', event => {
      if (drag?.id === event.pointerId) finish(true);
    });
    element.addEventListener('contextmenu', event => event.preventDefault());
    element.addEventListener('keydown', event => {
      const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (event.key === 'Escape') { finish(true); return; }
      if (!directions[event.key] || drag || selection) return;
      event.preventDefault();
      const [column, row] = directions[event.key];
      move(cube, cube.position.column + column, cube.position.row + row);
    });
  }

  for (const cube of cubes) connect(cube);

  field.addEventListener('pointerdown', event => {
    if (event.target.closest('.cube') || drag || selection || !event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    const start = pointerCell(event);
    selection = {
      id: event.pointerId, start, end: { ...start },
      selected: new Set(cubes.filter(cube => cube.selected)),
    };
    for (const cube of cubes) cube.selected = false;
    field.setPointerCapture(event.pointerId);
    render();
  });
  field.addEventListener('pointermove', followSelection);
  field.addEventListener('pointerup', event => {
    if (selection?.id !== event.pointerId) return;
    followSelection(event);
    finishSelection(false);
  });
  for (const type of ['pointercancel', 'lostpointercapture']) {
    field.addEventListener(type, event => {
      if (selection?.id === event.pointerId) finishSelection(true);
    });
  }

  window.addEventListener('blur', cancelGestures);
  window.addEventListener('resize', cancelGestures);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') cancelGestures();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelGestures();
  });
  render();
})();
