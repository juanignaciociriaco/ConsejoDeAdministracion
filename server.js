require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors({
  origin: '*' // En producción reemplazá por tu dominio: 'https://consorciolaenriqueta.com'
}));

// ── FRONTEND EN EL MISMO PROCESO ──
app.use(express.static(__dirname));
app.get('/', (_, res) => {
  res.sendFile(path.join(__dirname, 'la-enriqueta.html'));
});

// ── PADRÓN DESDE CSV (LOTE + MÚLTIPLES DNI) ──
const PADRON_CSV_PATH = process.env.PADRON_CSV_PATH || path.join(__dirname, 'padron_propietarios.csv');
const RESERVA_CC_EMAIL = process.env.RESERVA_CC_EMAIL || 'consejo@consorciolaenriqueta.com';
let padronPorLote = new Map();
let padronMtimeMs = 0;

function normalizeLote(value) {
  return String(value ?? '').trim();
}

function normalizeDni(value) {
  return String(value ?? '').replace(/\D/g, '').slice(0, 8);
}

function parseCsvLine(line) {
  return line.split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
}

function cargarPadronCsv() {
  const raw = fs.readFileSync(PADRON_CSV_PATH, 'utf8');
  const lineas = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  if (lineas.length === 0) {
    throw new Error('El archivo CSV de padrón está vacío.');
  }

  const header = parseCsvLine(lineas[0]).map((h) => h.toLowerCase());
  const idxLote = header.indexOf('lote');
  const dniColumnIndexes = header
    .map((name, index) => ({ name, index }))
    .filter(({ name }) => /^dni\d*$/.test(name))
    .map(({ index }) => index);

  if (idxLote === -1 || dniColumnIndexes.length === 0) {
    throw new Error('El CSV debe tener encabezado "lote" y al menos una columna DNI (por ejemplo "dni", "dni1", "dni2").');
  }

  const nuevoPadron = new Map();

  for (let i = 1; i < lineas.length; i += 1) {
    const linea = lineas[i];
    if (linea.startsWith('#')) continue;

    const columnas = parseCsvLine(linea);
    const lote = normalizeLote(columnas[idxLote]);
    if (!lote) continue;

    if (!nuevoPadron.has(lote)) {
      nuevoPadron.set(lote, new Set());
    }

    dniColumnIndexes.forEach((idx) => {
      const dni = normalizeDni(columnas[idx]);
      if (dni) {
        nuevoPadron.get(lote).add(dni);
      }
    });

    if (nuevoPadron.get(lote).size === 0) {
      nuevoPadron.delete(lote);
    }
  }

  padronPorLote = nuevoPadron;
  console.log(`✅ Padrón CSV cargado: ${padronPorLote.size} lotes desde ${PADRON_CSV_PATH}`);
}

function asegurarPadronActualizado() {
  const stat = fs.statSync(PADRON_CSV_PATH);
  if (stat.mtimeMs !== padronMtimeMs) {
    cargarPadronCsv();
    padronMtimeMs = stat.mtimeMs;
  }
}

function validarLoteDniContraPadron(lote, dni) {
  const loteNormalizado = normalizeLote(lote);
  const dniNormalizado = normalizeDni(dni);
  const dnisDelLote = padronPorLote.get(loteNormalizado);
  return Boolean(dnisDelLote && dnisDelLote.has(dniNormalizado));
}

try {
  asegurarPadronActualizado();
} catch (err) {
  console.error(`❌ No se pudo cargar el padrón CSV: ${err.message}`);
}

// ── TRANSPORTER SMTP CARBONIO ──
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: false,       // false = STARTTLS en puerto 587
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: false // útil si el cert es autofirmado en Carbonio
  }
});

// ── VERIFICAR CONEXIÓN AL ARRANCAR ──
transporter.verify((error) => {
  if (error) {
    console.error('❌ Error SMTP:', error.message);
  } else {
    console.log('✅ SMTP Carbonio conectado y listo');
  }
});

// ── TEMPLATE HTML DEL MAIL ──
function buildMailHtml({ nombre, apellido, lote, dni, celular, fechaStr, hora, jitsiUrl }) {
  return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirmación de turno</title>
</head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:'Georgia',serif;">

  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0e8;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

          <!-- CABECERA -->
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="
                    background:#2d4a2d;
                    border-radius:50%;
                    width:64px;height:64px;
                    text-align:center;
                    vertical-align:middle;
                    font-size:28px;
                    line-height:64px;
                  ">🏡</td>
                </tr>
              </table>
              <div style="margin-top:14px;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#5a6e5a;">
                Consorcio Club de Campo
              </div>
              <div style="font-size:28px;font-weight:300;color:#2d4a2d;margin-top:4px;letter-spacing:-0.5px;">
                La Enriqueta
              </div>
            </td>
          </tr>

          <!-- CUERPO -->
          <tr>
            <td style="
              background:#ffffff;
              border-radius:20px;
              padding:36px 40px;
              border:1px solid rgba(45,74,45,0.12);
              box-shadow:0 4px 24px rgba(45,74,45,0.08);
            ">
              <div style="font-size:22px;font-weight:300;color:#2d4a2d;margin-bottom:6px;">
                ¡Turno confirmado, ${nombre}!
              </div>
              <div style="font-size:14px;color:#5a6e5a;margin-bottom:28px;line-height:1.6;">
                Tu reunión con el Consejo de Administración quedó registrada.<br>
                Guardá este mail — tiene el link para ingresar a la videollamada.
              </div>

              <!-- DETALLE TURNO -->
              <table width="100%" cellpadding="0" cellspacing="0" style="
                background:#f5f0e8;
                border-radius:12px;
                padding:20px 24px;
                margin-bottom:28px;
              ">
                <tr>
                  <td style="padding:6px 0;">
                    <span style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#5a6e5a;">Fecha y hora</span><br>
                    <span style="font-size:17px;color:#1a2e1a;font-weight:500;">📅 &nbsp;${fechaStr} · ${hora} hs</span>
                  </td>
                </tr>
                <tr><td style="border-top:1px solid #e8e0d0;padding-top:12px;margin-top:8px;"></td></tr>
                <tr>
                  <td style="padding:6px 0 6px;">
                    <span style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#5a6e5a;">Propietario</span><br>
                    <span style="font-size:15px;color:#1a2e1a;">👤 &nbsp;${nombre} ${apellido}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:6px 0;">
                    <span style="font-size:15px;color:#1a2e1a;">🏡 &nbsp;Lote ${lote} &nbsp;·&nbsp; DNI ${dni}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:6px 0;">
                    <span style="font-size:15px;color:#1a2e1a;">📱 &nbsp;${celular}</span>
                  </td>
                </tr>
              </table>

              <!-- BOTÓN JITSI -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center">
                    <a href="${jitsiUrl}" style="
                      display:inline-block;
                      background:linear-gradient(135deg,#2d4a2d,#4a7c4a);
                      color:#ffffff;
                      text-decoration:none;
                      padding:15px 36px;
                      border-radius:12px;
                      font-size:16px;
                      font-family:'Georgia',serif;
                      letter-spacing:0.3px;
                      box-shadow:0 4px 16px rgba(45,74,45,0.35);
                    ">
                      🎥 &nbsp;Entrar a la videollamada
                    </a>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding-top:10px;font-size:12px;color:#8a9e8a;">
                    El link se activa 5 minutos antes del turno
                  </td>
                </tr>
              </table>

              <!-- NOTA -->
              <div style="
                margin-top:28px;
                padding:14px 18px;
                background:#fffdf7;
                border-left:3px solid #c9a84c;
                border-radius:4px;
                font-size:13px;
                color:#5a6e5a;
                line-height:1.7;
              ">
                <strong style="color:#2d4a2d;">¿Necesitás cambiar el turno?</strong><br>
                Respondé este mail o escribinos a 
                <a href="mailto:consejo@consorciolaenriqueta.com" style="color:#4a7c4a;">
                  consejo@consorciolaenriqueta.com
                </a>
                <br><br>
                <strong style="color:#2d4a2d;">Importante:</strong>
                si el número de lote y el DNI no coinciden con los datos del propietario,
                la reserva quedará cancelada.
              </div>
            </td>
          </tr>

          <!-- PIE -->
          <tr>
            <td align="center" style="padding:24px 0 0;font-size:11px;color:#8a9e8a;letter-spacing:0.5px;">
              © ${new Date().getFullYear()} · Consorcio Club de Campo La Enriqueta<br>
              Este es un mensaje automático — no responder a esta dirección.
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>
  `.trim();
}

// ── ENDPOINT RESERVA ──
app.post('/api/reserva', async (req, res) => {
  const { nombre, apellido, dni, lote, celular, email, fecha, hora, jitsiUrl } = req.body;

  // Validación básica
  const required = { nombre, apellido, dni, lote, celular, email, fecha, hora };
  const faltantes = Object.entries(required).filter(([, v]) => !v || !String(v).trim());
  if (faltantes.length > 0) {
    return res.status(400).json({
      ok: false,
      error: `Faltan campos: ${faltantes.map(([k]) => k).join(', ')}`
    });
  }

  try {
    asegurarPadronActualizado();
  } catch (err) {
    console.error(`❌ Error al leer padrón CSV: ${err.message}`);
    return res.status(503).json({
      ok: false,
      error: 'No se pudo validar el padrón de propietarios. Intentá nuevamente más tarde.'
    });
  }

  if (!validarLoteDniContraPadron(lote, dni)) {
    return res.status(403).json({
      ok: false,
      error: 'El número de lote y DNI no coinciden con el padrón. La reserva queda cancelada.'
    });
  }

  // Formatear fecha legible
  const [y, m, d] = fecha.split('-');
  const diasSemana = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  const mesesNombre = ['enero','febrero','marzo','abril','mayo','junio',
                       'julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const dateObj = new Date(Number(y), Number(m) - 1, Number(d));
  const fechaStr = `${diasSemana[dateObj.getDay()]} ${d} de ${mesesNombre[Number(m) - 1]} de ${y}`;

  const htmlBody = buildMailHtml({ nombre, apellido, lote, dni, celular, fechaStr, hora, jitsiUrl });

  try {
    await transporter.sendMail({
      from: `"Consorcio La Enriqueta" <${process.env.SMTP_USER}>`,
      to: email,
      cc: RESERVA_CC_EMAIL,
      subject: `✅ Turno confirmado – ${fechaStr} ${hora} hs`,
      html: htmlBody,
    });

    console.log(`📬 Mail enviado a ${email} (cc: ${RESERVA_CC_EMAIL}) — ${fechaStr} ${hora}`);
    res.json({ ok: true, message: 'Reserva confirmada y mail enviado.' });

  } catch (err) {
    console.error('❌ Error al enviar mail:', err.message);
    res.status(500).json({ ok: false, error: 'No se pudo enviar el mail. Revisá la config SMTP.' });
  }
});

// ── HEALTH CHECK ──
app.get('/api/health', (_, res) => res.json({
  ok: true,
  service: 'La Enriqueta API',
  padronLotes: padronPorLote.size
}));

// ── START ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
