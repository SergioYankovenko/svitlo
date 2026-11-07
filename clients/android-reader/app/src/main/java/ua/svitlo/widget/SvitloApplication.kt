package ua.svitlo.widget

import android.app.Application
import android.content.res.Configuration

class SvitloApplication:Application() {
    override fun onCreate(){
        super.onCreate()
        ua.svitlo.widget.next.NextPush.initialize(this)
        // App-local night mode is also available to native components/IMEs that follow it.
        // Keyboard vendors and user-selected keyboard themes retain control of their colors.
        if(android.os.Build.VERSION.SDK_INT>=31)getSystemService(android.app.UiModeManager::class.java).setApplicationNightMode(android.app.UiModeManager.MODE_NIGHT_YES)
    }
    override fun onConfigurationChanged(newConfig:Configuration){
        super.onConfigurationChanged(newConfig)
        // RemoteViews recolor XML automatically; refresh bitmap charts to the same palette.
        WidgetRenderer.enqueueUpdate(this)
    }
}
