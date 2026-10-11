plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.vectorcall.companion"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.vectorcall.companion"
        minSdk = 31          // TelephonyCallback needs API 31; the Nothing Phone (2) runs 14+
        targetSdk = 35
        versionCode = 2
        versionName = "0.2.0-poc"
    }

    signingConfigs {
        getByName("debug") {
            // Committed debug-only key so every CI build has the same signature
            // and installs over the previous one without uninstalling.
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    // Release builds are signed with the institute's own key, supplied through environment
    // variables (set from GitHub secrets in CI). The key never lives in the repo.
    signingConfigs {
        create("release") {
            System.getenv("VECTOR_KEYSTORE_PATH")?.let { path ->
                storeFile = file(path)
                storePassword = System.getenv("VECTOR_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("VECTOR_KEY_ALIAS")
                keyPassword = System.getenv("VECTOR_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        getByName("debug") {
            signingConfig = signingConfigs.getByName("debug")
        }
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        // LinkServer reads BuildConfig.DEBUG to allow the localhost origins in debug builds only.
        buildConfig = true
    }

    packaging {
        resources {
            // bcprov and bcpkix both ship this file; without the exclude the APK merge step fails.
            excludes += "META-INF/versions/9/OSGI-INF/MANIFEST.MF"
        }
    }
}

dependencies {
    // Makes the phone's self-signed HTTPS certificate (LinkTls.kt). Android cannot do this with its own API.
    implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")
    implementation("org.bouncycastle:bcpkix-jdk18on:1.78.1")
    // Draws the pairing QR code on the phone's screen (QrCode.kt). Encoding only, no camera code.
    implementation("com.google.zxing:core:3.5.3")
}
