# Mobile App Build Guide (Android APK & iOS IPA)
**Project**: Kotak Neo PIP Trading Terminal  
**Platform**: Android & iOS (via Capacitor native container)

This repository includes a native Capacitor configuration that bundles the entire web trading terminal into native Android and iOS mobile applications, pointing directly to your live production backend with full native WebView acceleration, offline caching, and push notification capability.

---

## Option 1: Instant iOS & Android PWA Installation (Zero Build Required)

Both iOS Safari and Android Chrome provide native Progressive Web App (PWA) support that gives an identical native experience without needing an App Store certificate or IPA code-signing:

### On iPhone (iOS):
1. Open Safari and navigate to `https://neo-pip-terminal.vercel.app`
2. Tap the **Share** button (box with upward arrow at bottom)
3. Scroll down and tap **"Add to Home Screen"**
4. Tap **"Add"**
5. **Result**: An app icon labeled **"Kotak Neo"** appears on your home screen. When launched, it runs in **standalone full-screen mode** (no Safari URL bar, no bottom bar, 120Hz ProMotion touch scrolling, full local storage).

### On Android:
1. Open Chrome and navigate to `https://neo-pip-terminal.vercel.app`
2. Tap the three dots (⋮) in the top right
3. Tap **"Install App"** or **"Add to Home Screen"**
4. **Result**: Native APK-equivalent standalone launcher on your home screen.

---

## Option 2: Build Native Android APK

### Prerequisites
- Node.js & npm (already installed on this Mac)
- Android Studio with Android SDK / command line tools

### Steps:
1. Install Capacitor dependencies:
   ```bash
   npm install
   ```
2. Initialize and sync the Android project:
   ```bash
   npx cap add android
   npx cap sync android
   ```
3. Build the Debug `.apk`:
   ```bash
   cd android
   ./gradlew assembleDebug
   ```
   The compiled `.apk` will be output at:
   `android/app/build/outputs/apk/debug/app-debug.apk`
4. Transfer `app-debug.apk` to any Android phone and tap to install!

---

## Option 3: Build Native iOS IPA

### Apple Requirements for iOS `.ipa`:
Because Apple enforces strict gatekeeping and code-signing on iOS, an `.ipa` file can only be compiled on macOS (which you have) using **Xcode** and signed with an **Apple Developer Account** (either a free personal team or paid \$99/year developer membership).

### Steps to Build `.ipa` on this Mac:
1. Ensure Xcode is installed from the Mac App Store.
2. Initialize and sync the iOS project:
   ```bash
   npm install
   npx cap add ios
   npx cap sync ios
   ```
3. Open the project in Xcode:
   ```bash
   npx cap open ios
   ```
4. In Xcode:
   - Select the **App** project in the left navigator.
   - Go to **Signing & Capabilities**.
   - Under **Team**, select your Apple ID (Personal Team).
   - In the top menu, select **Product** -> **Archive**.
   - Once the Organizer window appears, click **Distribute App** -> **Ad Hoc** or **Development** -> **Export**.
   - Select a destination folder to save the generated **`KotakNeoPIP.ipa`** file.
5. Install the IPA on your iPhone via Apple Configurator, Xcode Devices, or AirDrop with TestFlight/TrollStore.
