plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "ua.svitlo.widget"
    compileSdk = 35
    defaultConfig {
        applicationId = "ua.svitlo.widget"
        for (field in listOf("APP_ID","PROJECT_ID","API_KEY","SENDER_ID")) {
            val value = providers.gradleProperty("SVITLO_FIREBASE_" + field).orElse("").get()
            require(value.matches(Regex("[A-Za-z0-9:._-]*")))
            buildConfigField("String", "FIREBASE_" + field, "\"" + value + "\"")
        }
        minSdk = 26
        targetSdk = 35
        versionCode = 25
        versionName = "1.6.0"
        testInstrumentationRunner = "ua.svitlo.widget.DeviceAcceptance151"
        buildConfigField("boolean", "NEXT_API", "false")
    }
    buildFeatures { buildConfig = true }
    flavorDimensions += "generation"
    productFlavors {
        create("legacy") { dimension = "generation" }
        create("next") {
            dimension = "generation"
            applicationId = "ua.svitlo.widget.next"
            versionCode = 26
            versionName = "1.7.0"
            testInstrumentationRunner = "ua.svitlo.widget.next.NextAcceptance170"
            buildConfigField("boolean", "NEXT_API", "true")
            resValue("string", "app_name", "Світло · 1.7 Тест")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildTypes {
        getByName("debug") {
            applicationIdSuffix = ".qa"
            resValue("string", "app_name", "Світло · Тест")
        }
    }
    testOptions { unitTests.isIncludeAndroidResources = true }
}
dependencies {
    implementation(platform("com.google.firebase:firebase-bom:35.0.0"))
    implementation("com.google.firebase:firebase-messaging")
    implementation("androidx.work:work-runtime-ktx:2.10.1")
    implementation("com.google.zxing:core:3.5.3")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    testImplementation("org.robolectric:robolectric:4.14.1")
    testImplementation("androidx.work:work-testing:2.10.1")
}
