# Paternoster Filament Storage
Use this adress to open the program in your browser but put your raspberry pi IP adress: http://192.168.X.XX:3000/

## Installation on Raspberry Pi

if git isnt installed already on your device:
    
    sudo apt update && sudo apt install -y git


Put this commands in your terminal:

1. Download repo:
   ```bash
   git clone https://github.com/Swede-maker/paternoster-filament-storage.git && cd paternoster-filament-storage
   
2. Install:
   ```bash
   sudo apt update
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt install -y nodejs

2.1 Then this:  

    cd paternoster-filament-storage
    npm install
    npm run build
   

4. Start the server

   ```bash
   export PATERNOSTER_DB_PATH="$(pwd)/paternoster.db"
   npm run start

5. systemd unit so the agent starts on boot and restarts on crash.
 NOTE! change "raspberry" to the name your PI is using. Install:

       
       sudo nano /etc/systemd/system/paternoster.service

PASTE THIS

    [Unit]
    Description=Pawn Filament Paternoster Next.js Service
    After=network.target

    [Service]
    Type=simple
    User=raspberry
    WorkingDirectory=/home/raspberry/paternoster-filament-storage
    Environment=PATERNESTER_DB_PATH=/home/raspberry/paternoster-filament-storage/paternoster.db
    ExecStart=/usr/bin/npx next start -H 0.0.0.0
    Restart=always

    [Install]
    WantedBy=multi-user.target

CTRL+O and CTRL+X
Activate/Start the server:

    sudo systemctl daemon-reload
    sudo systemctl enable --now paternoster.service


The installation is DONE now. but here below is the command to restart the server if ever needed:

    sudo systemctl restart paternoster.service

If you want to use the scan barcode if the phone dosent open your camera you need to install caddy. I paste the command below. but note that some barcode dose note even get scanned.
    
    sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
    sudo apt update && sudo apt install caddy

Now you need to open the caddy folder:

    sudo nano /etc/caddy/Caddyfile

Erase all that is there and paste this, but write in your end of the PIs IP where the x is:

  192.168.x.xx {
  reverse_proxy localhost:3000
}

Now press CTRL+O and press yes and CTRL+X

Restart the caddy:

    sudo systemctl restart caddy

Now you need to paste or go to https://192.168.x.xx use your raspberry pi IP adress here, but note that you dont need the port 3000 in here.

UNINSTALL:


    sudo systemctl stop paternoster.service
    sudo systemctl disable paternoster.service
    sudo rm /etc/systemd/system/paternoster.service
    sudo systemctl daemon-reload
    rm -rf ~/paternoster-filament-storage
