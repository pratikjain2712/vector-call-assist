# Vector Call Assist

v2 of the Vector call guide. It has two parts: the call-guide website and an Android companion app that places normal SIM calls from the laptop and reports what happened on each call.

| Folder | What it is | Status |
|---|---|---|
| `web/` | The call guide (v1 copied as-is; uses its own saved data and can import your v1 lead sheet) | Phase 4 adds the phone controls |
| `android/` | Vector Companion: Kotlin app for the Nothing Phone (2), with no third-party libraries | **Phase 2 proof of concept** |
| `docs/` | Architecture, permissions, test plan | |

v1 stays live and untouched at https://pratikjain2712.github.io/vector-call-guide/.

## Get the APK (no Android Studio needed)

1. Push to GitHub. The **Android debug APK** workflow starts on its own.
2. Open the repo on GitHub → **Actions** → the latest *Android debug APK* run → **Artifacts** → `vector-companion-debug-apk`. The download is a zip with the `.apk` inside.
3. Copy the APK to the phone and open it. Allow "Install unknown apps" for the app you opened it with.

Every build is signed with the same debug key (`android/app/debug.keystore`), so a new build installs over the old one and the log is kept. That key is for testing only and must never be used for a real release.

## Build locally (optional)

1. Install Android Studio and open the `android/` folder. Let it sync.
2. Use **Build → Build APK(s)**, or run `gradlew.bat assembleDebug` inside `android/`.
3. The APK is at `android/app/build/outputs/apk/debug/app-debug.apk`.

Versions: AGP 8.7.3, Kotlin 2.0.21, Gradle 8.11.1, compileSdk/targetSdk 35, minSdk 31, JDK 17.

## Website on GitHub Pages

The site in `web/` is published by `.github/workflows/pages.yml`. **One-time setup:** repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.

It will be live at https://pratikjain2712.github.io/vector-call-assist/.

## Docs

- [Phase 2 test plan](docs/phase2-test-plan.md): what to run on the phone and what to send back
- [Permissions](docs/permissions.md): every permission, why it's needed, and how to grant it
- [Architecture and decisions](docs/architecture.md)
- [Phase A plan](docs/phase-a-plan.md): campaigns, scripts, new admin, Insights, WhatsApp: what is done and what is open
- [Data contract](docs/data-contract.md): tables, money rules and every database function the pages call
- [Supabase setup](docs/supabase-setup.md): connecting the website to Supabase and applying the migrations
- [AI script drafts: quality check](docs/ai-draft-quality.md): Haiku and Sonnet drafts compared, cost per draft
- [Weekly brief](docs/weekly-brief.md): the Monday email, its Edge Function and schedule
- [WhatsApp setup](docs/whatsapp-setup.md): Meta account, connecting a number, templates, secrets and the daily jobs
