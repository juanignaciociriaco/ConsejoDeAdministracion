# 🏡 Backend – Consorcio Club de Campo La Enriqueta

## Requisitos
- Node.js 18+ instalado en el VPS
- Puerto 3000 accesible (o configurá un reverse proxy con nginx)
- Casilla `avisos@consorciolaenriqueta.com` activa en Carbonio

---

## 1. Instalación

```bash
# Subí la carpeta backend/ a tu VPS y entrá
cd backend

# Instalá dependencias
npm install

# Copiá el .env y editá la contraseña
cp .env .env.local   # opcional, el archivo .env ya está listo
nano .env
```

En el `.env` completá:
```
SMTP_PASS=tu_contraseña_real_aqui
```

---

## 2. Probar localmente

```bash
node server.js
# → ✅ SMTP Carbonio conectado y listo
# → 🚀 Servidor corriendo en http://localhost:3000
```

Probá el health check:
```bash
curl http://localhost:3000/api/health
# → {"ok":true,"service":"La Enriqueta API"}
```

### Validación lote + DNI con CSV

El backend valida cada reserva contra un padrón CSV editable.

Archivo usado por defecto:

```bash
padron_propietarios.csv
```

Formato mínimo requerido (encabezados obligatorios):

```csv
lote,dni
39,32844293
40,30111222
```

También se soporta formato con múltiples DNI por lote en una sola fila:

```csv
lote,consorcista1,dni1,consorcista2,dni2,consorcista3,dni3,email1,email2,email3
39,Juan Perez,32844293,Ana Perez,30111222,,,juan@mail.com,ana@mail.com,
```

Reglas de lectura del padrón:
- Es obligatorio `lote`.
- Debe existir al menos una columna DNI: `dni`, `dni1`, `dni2`, `dni3`, etc.
- Cualquier otra columna (`consorcista*`, `email*`, etc.) se permite y no afecta la validación.

Comportamiento:
- Si lote y DNI coinciden con el padrón: la reserva sigue normal.
- Si no coinciden: responde `403` y la reserva queda cancelada.
- Si el CSV no está disponible: responde `503`.

Opcional: cambiar ruta del CSV por variable de entorno:

```bash
PADRON_CSV_PATH=/ruta/al/padron.csv
```

### Usar Google Sheets como origen de verdad

Si tu padrón vive en Google Sheets, podés usarlo como fuente principal sin tocar archivos locales.

1. En la hoja de Google, abrí `Archivo` → `Compartir` → `Publicar en la web`.
2. Elegí la pestaña del padrón y formato `CSV`.
3. Copiá la URL publicada (formato típico):

```txt
https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/export?format=csv&gid=GID
```

4. En el `.env`, configurá:

```bash
PADRON_SHEETS_CSV_URL=https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/export?format=csv&gid=GID
PADRON_REFRESH_MS=300000
PADRON_FETCH_TIMEOUT_MS=8000
```

Notas:
- `PADRON_SHEETS_CSV_URL`: si está definida, se usa Google Sheets como fuente principal.
- `PADRON_REFRESH_MS`: cada cuánto refresca en memoria (default: 5 minutos).
- `PADRON_FETCH_TIMEOUT_MS`: timeout de descarga del CSV (default: 8 segundos).
- Si Google Sheets falla temporalmente, el backend mantiene el último padrón cargado en memoria.
- Si no hay padrón en memoria, intenta fallback a `PADRON_CSV_PATH`.

---

## 3. Correr en producción con PM2

```bash
# Instalá PM2 globalmente
npm install -g pm2

# Iniciá el servidor
pm2 start server.js --name "la-enriqueta-api"

# Que arranque solo al reiniciar el VPS
pm2 save
pm2 startup
```

---

## 4. Nginx como reverse proxy (recomendado)

Si tenés nginx, creá `/etc/nginx/sites-available/laenriqueta-api`:

```nginx
server {
    listen 80;
    server_name api.consorciolaenriqueta.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/laenriqueta-api /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

Con SSL (certbot):
```bash
certbot --nginx -d api.consorciolaenriqueta.com
```

---

## 5. Apuntar el frontend al backend

En `la-enriqueta.html`, buscá esta línea y cambiá la URL:

```js
const API_URL = 'http://localhost:3000/api/reserva';
// Cambiar por:
const API_URL = 'https://api.consorciolaenriqueta.com/api/reserva';
```

---

## Estructura de archivos

```
backend/
├── server.js      ← Servidor Express + Nodemailer
├── package.json
├── .env           ← Credenciales SMTP (NO subir a git)
└── README.md

la-enriqueta.html  ← Frontend (subir a hosting estático o VPS)
```

---

## Variables de entorno

| Variable    | Valor                              |
|-------------|-------------------------------------|
| SMTP_HOST   | m.consorciolaenriqueta.com         |
| SMTP_PORT   | 587                                 |
| SMTP_USER   | avisos@consorciolaenriqueta.com    |
| SMTP_PASS   | (tu contraseña)                    |
| PORT        | 3000                                |
# ConsejoDeAdministracion
