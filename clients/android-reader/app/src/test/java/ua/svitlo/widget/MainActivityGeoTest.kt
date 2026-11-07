package ua.svitlo.widget

import android.app.Application
import android.content.Context
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.work.Configuration
import androidx.work.WorkManager
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import java.util.concurrent.Executor

/** Travel controls retired in 1.3: old persisted evidence must never change the active address weather. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk=[28])
@LooperMode(LooperMode.Mode.PAUSED)
class MainActivityGeoTest {
    private lateinit var context:Context
    @Before fun setup(){
        context=RuntimeEnvironment.getApplication()
        shadowOf(context as Application).grantPermissions(context.packageName+".DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION")
        listOf("svitlo_private","svitlo_weather","svitlo_runtime","svitlo_geo","svitlo_profiles").forEach{context.getSharedPreferences(it,0).edit().clear().commit()}
        if(runCatching{WorkManager.getInstance(context)}.isFailure){val held=Executor{};WorkManager.initialize(context,Configuration.Builder().setExecutor(held).setTaskExecutor(held).build())}
        val repo=OutageRepository(context,OutageSource{_,_,_,_->"""{"DATETIME":"09:30 22.10.2026","DISCONNECTIONS":[],"DISCONN_QUEUQ":[]}"""})
        assertTrue(repo.bindConfirmed("12345678901","м. Приклад, вул. Тестова, 1",repo.prepare("12345678901"),"м. Приклад"))
    }
    @Test fun upgradeDiscardsTravelWeatherAndLocationEvidenceWithoutChangingAddress(){
        val binding=OutageRepository(context).binding()
        WeatherRepository(context).bindLocation(WeatherLocation("Інше місто","Інша область",50.0,31.0))
        context.getSharedPreferences("svitlo_geo",0).edit().putBoolean("enabled",true).putString("history","old-travel-evidence").commit()
        val controller=Robolectric.buildActivity(MainActivity::class.java).create().start().resume().visible()
        try{
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(binding,OutageRepository(context).binding())
            assertNull(WeatherRepository(context).location())
            assertFalse(context.getSharedPreferences("svitlo_geo",0).contains("history"))
            assertFalse(context.getSharedPreferences("svitlo_geo",0).getBoolean("enabled",true))
            fun texts(view:View):String=(if(view is TextView)view.text.toString() else "")+if(view is ViewGroup)(0 until view.childCount).joinToString{ texts(view.getChildAt(it)) }else ""
            val visible=texts(controller.get().window.decorView)
            assertTrue(visible.contains("м. Приклад"));assertFalse(visible.contains("Інше місто"))
        }finally{controller.pause().stop().destroy()}
    }
}
