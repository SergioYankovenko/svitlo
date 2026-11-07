package ua.svitlo.widget

import android.app.AlertDialog
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.drawable.GradientDrawable
import android.view.ContextThemeWrapper
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.ListView
import android.widget.TextView

/** Keep native dialog sizing/IME handling while using the same palette as the app. */
object AppDialogs {
    fun builder(context:Context)=AlertDialog.Builder(ContextThemeWrapper(context,if(AppAppearance.light(context))R.style.SvitloDialogLight else R.style.SvitloDialog))
    fun style(dialog:AlertDialog){
        val colors=Palette.app(dialog.context);val density=dialog.context.resources.displayMetrics.density
        dialog.window?.setBackgroundDrawable(GradientDrawable().apply{
            setColor(colors.surface);cornerRadius=24*density
        })
        dialog.window?.setElevation(0f)
        dialog.window?.decorView?.apply{stateListAnimator=null;elevation=0f;translationZ=0f}
        // Shared panels already style each semantic role, including selected and
        // cancelling actions. Do not overwrite those colors during native setup.
        if(dialog.window?.decorView?.findViewWithTag<View>("svitlo_dialog_panel")!=null)return
        fun visit(view:View){
            if(view is TextView)view.setTextColor(colors.ink)
            if(view is EditText){view.setHintTextColor(colors.muted);view.backgroundTintList=ColorStateList.valueOf(colors.accent)}
            if(view is ListView){view.divider=null;view.cacheColorHint=colors.surface}
            if(view is ViewGroup)for(index in 0 until view.childCount)visit(view.getChildAt(index))
        }
        dialog.window?.decorView?.let(::visit)
        val actionParents=mutableSetOf<ViewGroup>()
        for(id in listOf(AlertDialog.BUTTON_POSITIVE,AlertDialog.BUTTON_NEGATIVE,AlertDialog.BUTTON_NEUTRAL)){
            dialog.getButton(id)?.apply{
                setTextColor(colors.accent);isAllCaps=false;TextSizing.singleLine(this,14)
                minHeight=minHeight.coerceAtLeast((48*density).toInt())
                minimumHeight=minimumHeight.coerceAtLeast((48*density).toInt())
                if(visibility==View.VISIBLE)(parent as? ViewGroup)?.let{actionParents+=it}
            }
        }
        // Retain Android's dialog/IME measurement and add breathing room above its actions.
        for(parent in actionParents)parent.setPadding(parent.paddingLeft,
            parent.paddingTop.coerceAtLeast((16*density).toInt()),parent.paddingRight,parent.paddingBottom)
    }
}
