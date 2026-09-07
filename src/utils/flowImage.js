/**
 * WhatsApp Flows list images (CheckboxGroup/Radio) must be raw base64, ≤100KB.
 * Hero Image component can use data-URI and larger sizes.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');

const execFileAsync = promisify(execFile);

function resolveImageUrl(imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string') return null;
  const url = imageUrl.trim();
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/')) {
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    return base ? `${base}${url}` : null;
  }
  return null;
}

async function compressToJpeg(buf, maxBytes) {
  // Prefer sharp (Linux/Mac/Windows)
  try {
    const sharp = require('sharp');
    let width = 480;
    let quality = 65;
    for (let i = 0; i < 8; i += 1) {
      const out = await sharp(buf)
        .resize({ width, withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      if (out.length <= maxBytes) return out;
      quality -= 8;
      if (quality < 35) {
        width = Math.max(240, Math.floor(width * 0.8));
        quality = 60;
      }
    }
  } catch (_) {
    // sharp missing / failed
  }

  // macOS fallback: sips
  if (process.platform === 'darwin') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowimg-'));
    const input = path.join(dir, 'in.bin');
    const output = path.join(dir, 'out.jpg');
    try {
      fs.writeFileSync(input, buf);
      await execFileAsync('sips', ['-Z', '480', '-s', 'format', 'jpeg', '-s', 'formatOptions', '50', input, '--out', output]);
      const out = fs.readFileSync(output);
      if (out.length && out.length <= maxBytes) return out;
    } catch (err) {
      console.warn('[FlowImage] sips compress failed:', err.message);
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {
        /* ignore */
      }
    }
  }

  return null;
}

/**
 * @returns {Promise<string|null>} data URI (data:image/jpeg;base64,...) or null
 */
async function imageUrlToFlowBase64(imageUrl, maxBytes = 100_000) {
  const absolute = resolveImageUrl(imageUrl);
  if (!absolute) return null;
  try {
    const res = await axios.get(absolute, {
      responseType: 'arraybuffer',
      timeout: 15000,
      maxContentLength: 3_000_000,
      headers: {
        Accept: 'image/jpeg,image/png,image/*',
        'User-Agent': 'Mozilla/5.0 (compatible; HotelWhatsAppCRM/1.0)',
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    let buf = Buffer.from(res.data);
    if (!buf.length) return null;

    if (buf.length > maxBytes) {
      const compressed = await compressToJpeg(buf, maxBytes);
      if (!compressed) {
        console.warn('[FlowImage] too large after compress:', absolute, buf.length);
        return null;
      }
      buf = compressed;
    }

    const dataUri = `data:image/jpeg;base64,${buf.toString('base64')}`;
    console.log('[FlowImage] ok:', absolute, 'bytes=', buf.length);
    return dataUri;
  } catch (err) {
    console.warn('[FlowImage] fetch failed:', absolute, err.message);
    return null;
  }
}

/** Raw base64 for CheckboxGroup/RadioButtonsGroup `image` field (no data-URI prefix). */
async function imageUrlToFlowListBase64(imageUrl, maxBytes = 100_000) {
  const dataUri = await imageUrlToFlowBase64(imageUrl, maxBytes);
  if (!dataUri) return null;
  return dataUri.includes(',') ? dataUri.split(',')[1] : dataUri;
}

module.exports = {
  resolveImageUrl,
  imageUrlToFlowBase64,
  imageUrlToFlowListBase64,
};
