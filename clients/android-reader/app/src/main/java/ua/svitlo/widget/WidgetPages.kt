package ua.svitlo.widget

import android.appwidget.AppWidgetManager
import android.content.Context

/** Local navigation only. Each installed detailed widget keeps its own page. */
internal object WidgetPages {
    const val SIZE=4
    private fun prefs(context:Context)=context.getSharedPreferences("svitlo_widget_pages",Context.MODE_PRIVATE)
    fun count(addresses:Int)=((addresses.coerceAtLeast(1)-1)/SIZE)+1
    fun page(context:Context,id:Int,addresses:Int):Int {
        if(id==AppWidgetManager.INVALID_APPWIDGET_ID)return 0
        val saved=prefs(context).getInt("page_$id",0)
        val page=saved.coerceIn(0,count(addresses)-1)
        if(page!=saved)prefs(context).edit().putInt("page_$id",page).apply()
        return page
    }
    fun select(context:Context,id:Int,target:Int,addresses:Int) {
        if(id!=AppWidgetManager.INVALID_APPWIDGET_ID)prefs(context).edit()
            .putInt("page_$id",target.coerceIn(0,count(addresses)-1)).apply()
    }
    fun remove(context:Context,ids:IntArray) {
        val edit=prefs(context).edit();ids.forEach{edit.remove("page_$it")};edit.apply()
    }
}
