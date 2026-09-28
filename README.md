DEPLOY WANZ API - VERCEL ATAU VPS

================================================================================
DEPLOY KE VERCEL (GRATIS)
================================================================================

CARA 1 - VIA GITHUB:

1. Push project ke GitHub

2. Login ke vercel.com pakai akun GitHub

3. Klik Add New > Project

4. Pilih repository, klik Import

5. Biarkan semua pengaturan default:
   - Framework Preset: Other
   - Root Directory: ./
   - Build settings: kosong

6. Klik Deploy

Selesai. Dapat domain gratis seperti: wanz-api.vercel.app
Setiap git push otomatis deploy ulang.

CARA 2 - VIA TERMINAL:

npm install -g vercel
vercel login
vercel
vercel --prod

================================================================================
DEPLOY KE VPS (UBUNTU/DEBIAN)
================================================================================

STEP 1 - PERSIAPAN SERVER:

sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git software-properties-common
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

STEP 2 - CLONE PROJECT:

cd /var/www
git clone <URL_REPO_ANDA> wanz-api
cd wanz-api
npm install

STEP 3 - PM2 (AGAR APLIKASI TETAP JALAN):

sudo npm install pm2 -g
pm2 start index.js --name "wanz-api"
pm2 startup
pm2 save

STEP 4 - NGINX REVERSE PROXY:

sudo apt install nginx -y
sudo nano /etc/nginx/sites-available/wanz-api

Copy-paste ini (ganti domain_anda.com):

server {
    listen 80;
    server_name domain_anda.com www.domain_anda.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}

sudo ln -s /etc/nginx/sites-available/wanz-api /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx

STEP 5 - SSL GRATIS:

sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d domain_anda.com -d www.domain_anda.com

Ikuti instruksi, pilih redirect HTTP ke HTTPS.

================================================================================
CATATAN PENTING
================================================================================

- Jangan hardcode API key di file HTML atau client-side
- Selalu gunakan route /ai/gemini sebagai proxy server-side
- Untuk local testing: node index.js lalu buka http://localhost:3000

================================================================================