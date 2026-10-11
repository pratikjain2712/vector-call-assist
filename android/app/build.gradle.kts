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

    buildTypes {
        getByName("debug") {
            signingConfig = signingConfigs.getByName("debug")
        }
        getByName("release") {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

// No third-party libraries: only the Android framework and the Kotlin standard library.
