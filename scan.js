// Full-screen camera QR scanner. Uses the browser's BarcodeDetector where
// available (Chrome on Android) and falls back to the bundled jsQR library,
// which is loaded only the first time the scanner opens.

const scannerEl = document.getElementById('scanner');
const scannerVideo = document.getElementById('scanner-video');
const scannerStatus = document.getElementById('scanner-status');

let scanStream = null;
let scanRunning = false;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Couldn't load ${src}`));
    document.head.appendChild(script);
  });
}

async function makeDetector() {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const detector = new BarcodeDetector({ formats: ['qr_code'] });
        return async video => (await detector.detect(video))[0]?.rawValue;
      }
    } catch {
      // fall through to jsQR
    }
  }
  if (typeof jsQR !== 'function') await loadScript('vendor/jsQR.js');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return async video => {
    const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' })?.data;
  };
}

// Opens the scanner. onText(text) is called for every QR code seen; return
// true to accept it (the scanner closes) or a message string to keep scanning
// and show that message.
async function openScanner(onText) {
  scannerEl.hidden = false;
  scannerStatus.textContent = 'Starting camera…';
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (err) {
    scannerStatus.textContent = err.name === 'NotAllowedError'
      ? 'Camera access was blocked. Allow the camera for this app in your phone settings, or type the code instead.'
      : "Couldn't start the camera on this device. Type the code instead.";
    return;
  }
  if (scannerEl.hidden) return closeScanner(); // cancelled while the permission prompt was open

  scannerVideo.srcObject = scanStream;
  await scannerVideo.play().catch(() => {});
  scannerStatus.textContent = "Point the camera at the QR code on your friend's screen.";

  let detect;
  try {
    detect = await makeDetector();
  } catch {
    scannerStatus.textContent = "Couldn't load the QR reader. Check your connection, or type the code instead.";
    return;
  }

  scanRunning = true;
  const tick = async () => {
    if (!scanRunning) return;
    if (scannerVideo.readyState >= 2) {
      const text = await detect(scannerVideo).catch(() => null);
      if (text && scanRunning) {
        const result = onText(text);
        if (result === true) return closeScanner();
        if (typeof result === 'string') scannerStatus.textContent = result;
      }
    }
    setTimeout(() => requestAnimationFrame(tick), 150); // ~6 scans a second is plenty
  };
  tick();
}

function closeScanner() {
  scanRunning = false;
  if (scanStream) scanStream.getTracks().forEach(track => track.stop());
  scanStream = null;
  scannerVideo.srcObject = null;
  scannerEl.hidden = true;
}

document.getElementById('scanner-close').addEventListener('click', closeScanner);
