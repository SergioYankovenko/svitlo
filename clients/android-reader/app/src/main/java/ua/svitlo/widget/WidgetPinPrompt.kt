package ua.svitlo.widget

import android.app.Activity
import android.app.AlertDialog
import android.appwidget.AppWidgetManager
import android.os.Handler
import android.os.Looper
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import kotlin.math.roundToInt

/** The app owns confirmation: launchers are allowed to pin silently. */
class WidgetPinPrompt(private val activity:Activity,private val feedback:(String)->Unit) {
    private var dialog:AlertDialog?=null
    fun close(){dialog?.dismiss();dialog=null}
    fun show(compact:Boolean){
        if(activity.isFinishing || activity.isDestroyed || dialog?.isShowing==true)return
        if(WidgetPins.isPending(compact)){feedback("Запит уже надіслано. Завершіть додавання або перевірте головні екрани.");return}
        if(!AppWidgetManager.getInstance(activity).isRequestPinAppWidgetSupported){manual();return}
        val exists=WidgetPins.exists(activity,compact)
        val type=if(compact)"компактний"else"детальний"
        val title=if(exists)"Перевірте головні екрани"else"Додати $type віджет?"
        val message=if(exists)"Android уже має $type віджет «Світло». Він може бути на іншому екрані. Додавайте повторно лише якщо не можете його знайти — інакше з’явиться копія."
            else"Віджет з’явиться на одному з головних екранів. Якщо Android відкриє підтвердження, завершіть додавання."
        val content=build(title,message,if(exists)"Додати повторно"else"Додати",if(exists)"Закрити"else"Скасувати")
        val shown=content.dialog
        dialog=shown
        shown.setOnDismissListener{if(dialog===shown)dialog=null}
        var sent=false
        content.positive.setOnClickListener{
            if(!sent){
                sent=true;it.isEnabled=false;shown.dismiss()
                when(WidgetPins.request(activity,compact,allowExisting=exists)){
                    WidgetPins.Result.REQUESTED->feedback("Запит на додавання надіслано. Перевірте головні екрани.")
                    WidgetPins.Result.PENDING->feedback("Запит уже надіслано. Завершіть додавання або перевірте головні екрани.")
                    WidgetPins.Result.EXISTS->{
                        feedback("Віджет уже додано. Перевірте головні екрани.")
                        Handler(Looper.getMainLooper()).post{show(compact)}
                    }
                    WidgetPins.Result.FAILED->feedback("Не вдалося додати віджет. Спробуйте ще раз.")
                    WidgetPins.Result.UNSUPPORTED->manual()
                }
            }
        }
    }
    private data class Content(val dialog:AlertDialog,val positive:Button)
    private fun build(title:String,message:String,positiveLabel:String,negativeLabel:String?=null):Content {
        val panel=AppDialogPanel(activity,title,prefix="widget_pin")
        panel.setBody(panel.text(message,"widget_pin_message"))
        val negative=negativeLabel?.let{panel.button(it,"widget_pin_negative")}
        val positive=panel.button(positiveLabel,"widget_pin_positive")
        panel.footer(listOfNotNull(negative,positive),horizontal=activity.resources.configuration.fontScale<1.5f,proportional=true)
        val shown=panel.show()
        negative?.setOnClickListener{shown.dismiss()};positive.setOnClickListener{shown.dismiss()}
        return Content(shown,positive)
    }
    private fun manual(){
        dialog=build("Додати віджет","Затисніть порожнє місце на головному екрані → Віджети → Світло → оберіть потрібний розмір.","Зрозуміло").dialog
    }
}
