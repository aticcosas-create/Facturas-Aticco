// api/upload-drive.js
// Vercel Function — sube foto a Google Drive usando Service Account
// Sin OAuth, sin tokens que expiren, 100% automático

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { imageB64, fecha, numero } = req.body;
    if (!imageB64 || !fecha) return res.status(400).json({ error: 'Faltan datos' });

    // Obtener access token via JWT (Service Account)
    const token = await getServiceAccountToken();

    // Definir ruta: AÑO XXXX / MM NOMBRE XXXX
    const d = new Date(fecha);
    const anio = d.getFullYear();
    const numMes = d.getMonth();
    const meses = ['ENERO','FEBRERO','MARZO','ABRIL','MAYO','JUNIO','JULIO','AGOSTO','SEPTIEMBRE','OCTUBRE','NOVIEMBRE','DICIEMBRE'];
    const padMes = String(numMes + 1).padStart(2, '0');
    const nombreMes = `${padMes} ${meses[numMes]} ${anio}`;
    const nombreArchivo = `${fecha}_${(numero || 'sin-numero').replace(/[^a-zA-Z0-9-]/g, '_')}.jpg`;

    // Carpeta raíz Gastos (ID de Drive)
    const ROOT_FOLDER_ID = process.env.DRIVE_GASTOS_FOLDER_ID;

    // Obtener o crear carpeta del año
    const anioId = await getOrCreateFolder(token, `AÑO ${anio}`, ROOT_FOLDER_ID);
    // Obtener o crear carpeta del mes
    const mesId = await getOrCreateFolder(token, nombreMes, anioId);
    // Subir el archivo
    const fileId = await uploadFile(token, imageB64, nombreArchivo, mesId);

    return res.status(200).json({ ok: true, fileId, path: `AÑO ${anio}/${nombreMes}/${nombreArchivo}` });

  } catch (err) {
    console.error('upload-drive error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── JWT para Service Account ──────────────────────────────────────
async function getServiceAccountToken() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: email,
    scope: 'https://www.googleapis.com/auth/drive.file',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64(header)}.${b64(payload)}`;

  // Importar clave privada
  const keyData = rawKey
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const binaryKey = Buffer.from(keyData, 'base64');

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    Buffer.from(unsigned)
  );

  const jwt = `${unsigned}.${Buffer.from(signature).toString('base64url')}`;

  // Intercambiar JWT por access token
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('No se pudo obtener token: ' + JSON.stringify(data));
  return data.access_token;
}

// ── Buscar o crear carpeta en Drive ──────────────────────────────
async function getOrCreateFolder(token, name, parentId) {
  const q = `mimeType='application/vnd.google-apps.folder' and name='${name}' and '${parentId}' in parents and trashed=false`;
  const search = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await search.json();
  if (data.files && data.files.length > 0) return data.files[0].id;

  const create = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
  });
  const folder = await create.json();
  return folder.id;
}

// ── Subir archivo a Drive ─────────────────────────────────────────
async function uploadFile(token, b64, nombre, folderId) {
  const binary = Buffer.from(b64, 'base64');
  const meta = JSON.stringify({ name: nombre, parents: [folderId] });

  const boundary = 'facturapp_boundary';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`),
    binary,
    Buffer.from(`\r\n--${boundary}--`)
  ]);

  const upload = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body
  });
  const file = await upload.json();
  if (!file.id) throw new Error('Upload falló: ' + JSON.stringify(file));
  return file.id;
}
