package ua.svitlo.widget

import android.content.Context
import android.content.res.Configuration

/** Activity-only override: widgets retain their existing host/system palette. */
object AppAppearance {
    fun twoRows(context:Context)=context.getSharedPreferences("svitlo_ui",Context.MODE_PRIVATE).getBoolean("two_row_tiles",false)
    fun bulbs(context:Context)=context.getSharedPreferences("svitlo_ui",Context.MODE_PRIVATE).getBoolean("bulb_icons",false)
    fun setTwoRows(context:Context,value:Boolean){context.getSharedPreferences("svitlo_ui",Context.MODE_PRIVATE).edit().putBoolean("two_row_tiles",value).apply()}
    fun setBulbs(context:Context,value:Boolean){context.getSharedPreferences("svitlo_ui",Context.MODE_PRIVATE).edit().putBoolean("bulb_icons",value).apply()}
    fun light(context:Context)=context.getSharedPreferences("svitlo_ui",Context.MODE_PRIVATE).getBoolean("light_theme",false)
    fun setLight(context:Context,enabled:Boolean){
        context.getSharedPreferences("svitlo_ui",Context.MODE_PRIVATE).edit().putBoolean("light_theme",enabled).apply()
    }
    fun context(base:Context):Context {
        val configuration=Configuration(base.resources.configuration)
        configuration.uiMode=(configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
            if(light(base))Configuration.UI_MODE_NIGHT_NO else Configuration.UI_MODE_NIGHT_YES
        return base.createConfigurationContext(configuration)
    }
}
