# Paternoster Filament Storage

## Installation on Raspberry Pi

Put this commands in your terminal:

1. Download repo:
   ```bash
   git clone https://github.com/Swede-maker/paternoster-filament-storage.git && cd paternoster-filament-storage
   
2. Install:

   ```bash
   npm install
   npm run build
   

3. Start the server

   ```bash
   export PATERNESTER_DB_PATH="$(pwd)/paternoster.db"
   npm run start

4. systemd unit so the agent starts on boot and restarts on crash.
 NOTE! change "User" to the name your PI is using. Install:

       
       sudo nano /etc/systemd/system/paternoster.service

PASTE THIS

    [Unit]
    Description=Paternoster Filament Storage
    After=network.target

    [Service]
    Type=simple
    User=raspberry
    WorkingDirectory=/home/raspberry/paternoster-filament-storage
    ExecStart=/usr/bin/npm run start
    Restart=always
    Environment=PATERNESTER_DB_PATH=/home/raspberry/paternoster-filament-storage/paternoster.db

    [Install]
    WantedBy=multi-user.target

CTRL+O and CTRL+X
Activake/Start the server:

    sudo systemctl daemon-reload
    sudo systemctl enable --now paternoster.service


The installation is DONE now. but here below is the command to restart the server if ever needed:

    sudo systemctl restart paternoster.service



UNINSTALL:


    sudo systemctl stop paternoster.service
    sudo systemctl disable paternoster.service
    sudo rm /etc/systemd/system/paternoster.service
    sudo systemctl daemon-reload
    rm -rf ~/paternoster-filament-storage
