// ─── State ──────────────────────────────────────────────
let displayValue = '0';
let previousValue = '';
let operation = null;
let shouldResetDisplay = false;
let history = [];
let memory = 0;
let hasMemory = false;

// ─── DOM refs ─────────────────────────────────────────────
const displayMain = document.querySelector('.display-main');
const displayHistory = document.querySelector('.display-history');
const memoryIndicator = document.querySelector('.display-memory-indicator');
const memoryDisplay = document.querySelector('.memory-display');

// ─── Helpers ──────────────────────────────────────────────
function formatNumber(num) {
  if (num === '' || num === 'Error') return num;
  const n = parseFloat(num);
  if (isNaN(n)) return 'Error';
  if (Math.abs(n) >= 1e15 || Math.abs(n) < 0.00001 && n !== 0) {
    return n.toExponential(8);
  }
  const str = n.toString();
  if (str.includes('.')) {
    const [int, dec] = str.split('.');
    return int + '.' + dec.slice(0, 12);
  }
  return str;
}

function updateDisplay() {
  displayMain.textContent = formatNumber(displayValue);
  if (displayValue === 'Error') {
    displayMain.classList.add('error');
  } else {
    displayMain.classList.remove('error');
  }

  if (previousValue && operation) {
    displayHistory.textContent = `${formatNumber(previousValue)} ${operation}`;
  } else {
    displayHistory.textContent = '';
  }

  if (hasMemory) {
    memoryIndicator.classList.add('visible');
    memoryDisplay.textContent = `M = ${formatNumber(memory)}`;
  } else {
    memoryIndicator.classList.remove('visible');
    memoryDisplay.textContent = '';
  }
}

function showToast(msg) {
  const toast = document.querySelector('.toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 1500);
}

// ─── Ripple effect ────────────────────────────────────────
function createRipple(e, btn) {
  const rect = btn.getBoundingClientRect();
  const ripple = document.createElement('span');
  ripple.className = 'ripple';
  const size = Math.max(rect.width, rect.height);
  ripple.style.width = ripple.style.height = size + 'px';
  ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
  ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
  btn.appendChild(ripple);
  setTimeout(() => ripple.remove(), 400);
}

// ─── Core operations ──────────────────────────────────────
function appendNumber(num) {
  if (shouldResetDisplay && num !== '0') {
    displayValue = '';
    shouldResetDisplay = false;
  }
  if (displayValue === 'Error') {
    displayValue = num;
    shouldResetDisplay = false;
  } else if (displayValue === '0' && num !== '0') {
    displayValue = num;
  } else if (displayValue === '0' && num === '0') {
    // do nothing
  } else {
    if (displayValue.length < 20) {
      displayValue += num;
    }
  }
  updateDisplay();
}

function clear() {
  displayValue = '0';
  previousValue = '';
  operation = null;
  shouldResetDisplay = false;
  updateDisplay();
}

function clearEntry() {
  displayValue = '0';
  updateDisplay();
}

function backspace() {
  if (displayValue === 'Error') {
    clear();
    return;
  }
  if (displayValue.length > 1) {
    displayValue = displayValue.slice(0, -1);
  } else {
    displayValue = '0';
  }
  updateDisplay();
}

function setOperation(op) {
  if (operation && !shouldResetDisplay) {
    const result = compute(previousValue, displayValue, operation);
    if (result === 'Error') {
      showToast('Fehler!');
      return;
    }
    displayValue = result;
  }
  previousValue = displayValue;
  operation = op;
  shouldResetDisplay = true;
  updateDisplay();
}

function compute(a, b, op) {
  const x = parseFloat(a);
  const y = parseFloat(b);
  if (isNaN(x) || isNaN(y)) return 'Error';

  let result;
  switch (op) {
    case '+': result = x + y; break;
    case '-': result = x - y; break;
    case '×': result = x * y; break;
    case '÷':
      if (y === 0) return 'Error';
      result = x / y;
      break;
    case '%':
      if (y === 0) return 'Error';
      result = x % y;
      break;
    case '^':
      if (Math.abs(y) > 100 || y < -5) return 'Error';
      result = Math.pow(x, y); break;
    default: return 'Error';
  }

  if (result !== Infinity && result !== -Infinity) {
    return parseFloat(result.toPrecision(12)).toString();
  }
  return 'Error';
}

function equals() {
  if (!operation || shouldResetDisplay) return;
  const result = compute(previousValue, displayValue, operation);
  if (result === 'Error') {
    showToast('Fehler!');
    displayValue = 'Error';
  } else {
    history.push(`${formatNumber(previousValue)} ${operation} ${formatNumber(displayValue)} = ${result}`);
    if (history.length > 5) history.shift();

    displayValue = result;
    previousValue = '';
    operation = null;
    shouldResetDisplay = true;

    displayMain.style.transition = 'color 0.3s';
    displayMain.style.color = '#6c5ce7';
    setTimeout(() => {
      displayMain.style.transition = '';
      displayMain.style.color = '';
    }, 300);

    showToast(result === 'Error' ? 'Fehler!' : '✓');
  }
  updateDisplay();
}

// ─── Memory functions ─────────────────────────────────────
function memAdd() {
  const val = parseFloat(displayValue);
  if (!isNaN(val)) {
    memory += val;
    hasMemory = true;
    showToast('M+');
  }
}

function memSub() {
  const val = parseFloat(displayValue);
  if (!isNaN(val)) {
    memory -= val;
    hasMemory = true;
    showToast('M−');
  }
}

function memRecall() {
  displayValue = memory.toString();
  hasMemory = true;
  showToast('MR');
}

function memClear() {
  memory = 0;
  hasMemory = false;
  showToast('MC');
}

// ─── Scientific functions ────────────────────────────────
function scientificFunc(fn) {
  const val = parseFloat(displayValue);
  if (isNaN(val)) return;

  let result;
  switch (fn) {
    case 'sin': result = Math.sin(val * Math.PI / 180); break;
    case 'cos': result = Math.cos(val * Math.PI / 180); break;
    case 'tan': result = Math.tan(val * Math.PI / 180); break;
    case 'asin': result = Math.asin(val) * 180 / Math.PI; break;
    case 'acos': result = Math.acos(val) * 180 / Math.PI; break;
    case 'atan': result = Math.atan(val) * 180 / Math.PI; break;
    case 'log': result = Math.log10(val); break;
    case 'ln': result = Math.log(val); break;
    case 'sqrt': result = Math.sqrt(val); break;
    case 'x²': result = val * val; break;
    case '%': result = val / 100; break;
    case '±': result = -val; break;
    default: return;
  }

  if (!isNaN(result) && !isFinite(result)) {
    showToast('Fehler!');
    return;
  }

  displayValue = parseFloat(result.toPrecision(12)).toString();
  showToast(fn);
}

// ─── Keyboard support ─────────────────────────────────────
document.addEventListener('keydown', (e) => {
  const key = e.key;

  if (/^\d$/.test(key)) { appendNumber(key); return; }
  if (key === '.') { appendNumber('.'); return; }

  const opMap = {
    '+': '+', '-': '-', '*': '×', '/': '÷', '%': '%', '^': '^'
  };
  if (opMap[key]) { setOperation(opMap[key]); return; }

  switch (key) {
    case 'Enter': equals(); break;
    case 'Backspace': backspace(); break;
    case 'Escape': clearEntry(); break;
    case 'Delete': clear(); break;
  }

  if (['+', '-', '*', '/', '%', '^', 'Enter', 'Backspace', 'Escape', 'Delete'].includes(key)) {
    e.preventDefault();
  }
});

// ─── Initialize ───────────────────────────────────────────
updateDisplay();
