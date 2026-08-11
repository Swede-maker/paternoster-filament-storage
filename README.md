# Paternoster Filament Storage

## Installation on Raspberry Pi

Put this commands in your terminal:

1. Download repo:
   ```bash
   git clone [https://github.com/Swede-maker/paternoster-filament-storage.git](https://github.com/Swede-maker/paternoster-filament-storage.git)
   cd paternoster-filament-storage
   
2. Install:

   ```bash
   npm install
   npm run build
   

3. Start the server

   ```bash
   export PATERNESTER_DB_PATH="$(pwd)/paternoster.db"
   npm run start
