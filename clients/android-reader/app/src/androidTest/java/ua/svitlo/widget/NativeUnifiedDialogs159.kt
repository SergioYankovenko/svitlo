package ua.svitlo.widget

import android.app.AlertDialog
import android.app.Instrumentation
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.MotionEvent
import android.view.inputmethod.InputMethodManager
import android.widget.*
import org.json.JSONArray
import org.json.JSONObject

/** Real Android rendering and interactions, entirely within the offline QA fixture. */
object NativeUnifiedDialogs159 {
    fun verify(test:Instrumentation,activity:MainActivity):JSONObject {
        val context=test.targetContext;check(context.packageName.endsWith(".qa"))
        val density=context.resources.displayMetrics.density
        fun main(action:()->Unit){var failure:Throwable?=null;test.runOnMainSync{try{action()}catch(e:Throwable){failure=e}};failure?.let{throw it}}
        fun all(view:View):List<View> = listOf(view)+if(view is ViewGroup)(0 until view.childCount).flatMap{all(view.getChildAt(it))}else emptyList()
        fun bounds(view:View):Rect{val p=IntArray(2);view.getLocationOnScreen(p);return Rect(p[0],p[1],p[0]+view.width,p[1]+view.height)}
        fun settle(){test.waitForIdleSync();SystemClock.sleep(180);test.waitForIdleSync()}
        fun tap(view:View){
            val visible=Rect();main{
                check(view.getLocalVisibleRect(visible))
                val screen=IntArray(2);view.getLocationOnScreen(screen);visible.offset(screen[0],screen[1])
            }
            val down=SystemClock.uptimeMillis()
            for(action in listOf(MotionEvent.ACTION_DOWN,MotionEvent.ACTION_UP)){
                val event=MotionEvent.obtain(down,SystemClock.uptimeMillis(),action,visible.exactCenterX(),visible.exactCenterY(),0)
                event.source=android.view.InputDevice.SOURCE_TOUCHSCREEN
                check(test.uiAutomation.injectInputEvent(event,true));event.recycle()
                if(action==MotionEvent.ACTION_DOWN)SystemClock.sleep(60)
            }
            settle()
        }
        fun capture(name:String){test.uiAutomation.takeScreenshot()?.let{image->java.io.File(context.cacheDir,"unified159-$name.png").outputStream().use{image.compress(Bitmap.CompressFormat.PNG,100,it)}}}
        fun invoke(name:String,vararg values:Any?):Any? = MainActivity::class.java.declaredMethods.single{it.name==name}.apply{isAccessible=true}.invoke(activity,*values)
        val checks=JSONArray()
        fun inspect(name:String,root:View,footer:Boolean=true){
            main{
                val panel=all(root).single{it.tag=="svitlo_dialog_panel"}
                val labels=all(panel).filterIsInstance<TextView>()
                val heading=labels.single{it.tag?.toString()?.endsWith("_title")==true}
                val divider=all(panel).single{it.tag?.toString()?.endsWith("_divider")==true}
                check(androidx.core.view.ViewCompat.isAccessibilityHeading(heading))
                check(bounds(heading).bottom<bounds(divider).top)
                labels.firstOrNull{it.tag?.toString()?.endsWith("_context")==true || it.tag=="confirmed_address"}?.let{
                    check(it.maxLines==1 && it.ellipsize==android.text.TextUtils.TruncateAt.END)
                    check(bounds(heading).bottom<=bounds(it).top && bounds(it).bottom<bounds(divider).top)
                    check(kotlin.math.abs((bounds(it).top-bounds(heading).bottom)/density-4)<1)
                }
                check(labels.none{it.text.toString().contains("✓")})
                val window=bounds(root)
                val actions=all(panel).filterIsInstance<LinearLayout>().single{it.tag?.toString()?.endsWith("_actions")==true}
                if(footer && actions.visibility==View.VISIBLE)for(i in 0 until actions.childCount){
                    val button=actions.getChildAt(i) as Button
                    val visible=Rect();check(button.getGlobalVisibleRect(visible))
                    check(visible.height()==button.height && window.contains(bounds(button))){"$name clipped footer: ${button.text}, bounds=${bounds(button)}, window=$window"}
                    check(button.height/density>=47.9f && button.lineCount==1)
                    val layout=button.layout;val width=button.width-button.compoundPaddingLeft-button.compoundPaddingRight
                    check(layout.getLineMax(0)<=width+2){"$name clipped footer text: ${button.text}; ${layout.getLineMax(0)}/$width"}
                }
            }
            capture(name);checks.put(name)
        }
        var dialog:AlertDialog?=null
        try{
            main{dialog=invoke("manageAddressProfiles") as AlertDialog};settle()
            inspect("saved-addresses",dialog!!.window!!.decorView)
            main{
                val list=dialog!!.window!!.decorView.findViewWithTag<ListView>("saved_addresses_list")
                check(list.adapter.count==AddressProfiles(context).profiles().size)
                for(tag in listOf("managed_done","managed_add"))check(dialog!!.window!!.decorView.findViewWithTag<Button>(tag).gravity==android.view.Gravity.CENTER)
                check(all(dialog!!.window!!.decorView).filterIsInstance<TextView>().filter{it.text.toString().startsWith("м. Тестове")}.all{it.currentTextColor==Palette.app(context).ink})
            }
            tap(dialog!!.window!!.decorView.findViewWithTag("managed_done"));check(!dialog!!.isShowing)
            main{dialog=invoke("profileActions",AddressProfiles(context).profiles().first()) as AlertDialog}
            settle();inspect("address-actions",dialog!!.window!!.decorView,footer=false)
            main{
                check(all(dialog!!.window!!.decorView).filterIsInstance<Button>().filter{it.isShown}.map{it.text.toString()}==listOf("Перейменувати","Видалити адресу","Відмінити"))
            }
            tap(dialog!!.window!!.decorView.findViewWithTag("profile_action_cancel"));check(!dialog!!.isShowing)
            main{dialog=invoke("chooseReminderLead") as AlertDialog}
            settle();inspect("reminder",dialog!!.window!!.decorView,footer=false)
            main{
                val views=all(dialog!!.window!!.decorView);check(views.none{it is EditText})
                check(views.filterIsInstance<Button>().filter{it.isShown}.map{it.text.toString()}==listOf("5 хв","15 хв","30 хв","60 хв","Скасувати"))
            }
            tap(dialog!!.window!!.decorView.findViewWithTag("reminder_lead:15"))
            check(!dialog!!.isShowing && ScheduleNotifications.lead(context)==15)
            for(city in listOf(false,true)){
                var selected=""
                val items=if(city)listOf("м. Городище","с. В’язівок","с-ще Цвіткове","с. Чубівка","с. Старосілля","с. Мліїв","с. Валява")
                    else listOf("Черкаські міські енергетичні мережі","Смілянські енергетичні мережі","Уманські енергетичні мережі","Городищенська філія","Драбівська філія","Жашківська філія","Звенигородські енергетичні мережі")
                val label:(String)->String={it};val chosen:(String)->Unit={selected=it};val back:()->Unit={}
                fun open(){main{dialog=invoke("choose",if(city)"Населений пункт · Городищенська філія"else"Філія",items,label,null,if(city)"Змінити філію"else null,if(city)back else null,chosen) as AlertDialog};settle()}
                open()
                settle();inspect(if(city)"settlement"else"branch",dialog!!.window!!.decorView)
                // Reproduce a normal tap on the second, unfiltered row, as on
                // the reported phone; then exercise the filtered/IME path too.
                val initial=dialog!!.window!!.decorView.findViewWithTag<ListView>("address_picker_list")
                tap(initial.getChildAt(1).findViewWithTag("address_picker_item:1"))
                check(selected==items[1] && !dialog!!.isShowing){"Unfiltered row did not handle a real touch"}
                selected="";open()
                lateinit var query:EditText;lateinit var list:ListView
                main{
                    val root=dialog!!.window!!.decorView
                    query=root.findViewWithTag("address_picker_search");list=root.findViewWithTag("address_picker_list")
                    query.setText(if(city)"Вал"else"Драб");check(list.adapter.count==1)
                };settle()
                if(city){
                    main{query.requestFocus();activity.getSystemService(InputMethodManager::class.java).showSoftInput(query,InputMethodManager.SHOW_IMPLICIT)}
                    settle();SystemClock.sleep(300);inspect("settlement-keyboard",dialog!!.window!!.decorView)
                    main{check(list.height/density>=24);check(query.isShown)}
                }
                lateinit var hit:View
                main{
                    hit=list.getChildAt(0).findViewWithTag("address_picker_item:0")
                }
                tap(hit)
                if(selected.isEmpty())capture("touch-failure")
                check(selected==if(city)"с. Валява"else"Драбівська філія"){"Touch did not select exact filtered result"}
            }
            val previous=OutageRepository(context).binding();val profiles=AddressProfiles(context).profiles()
            main{invoke("confirmAddress","12345678999","с. Стійкове, вул. Захисників України, 4","с. Стійкове")};settle()
            inspect("confirmation",activity.window.decorView)
            main{
                val root=activity.window.decorView;val yes=root.findViewWithTag<Button>("confirm_yes");val no=root.findViewWithTag<Button>("confirm_no")
                check(bounds(yes).top==bounds(no).top && bounds(yes).right<=bounds(no).left)
                check(all(root).filterIsInstance<Button>().none{it.text.toString()=="Скасувати зміну"})
                val input=root.findViewWithTag<EditText>("profile_name");check(input.hint.toString()=="Назва адреси (необов’язково)")
                check(input.background.constantState!=null)
            }
            tap(activity.window.decorView.findViewWithTag("confirm_no"))
            main{check(OutageRepository(context).binding()==previous && AddressProfiles(context).profiles()==profiles);invoke("dashboard")}
            settle()
            val pin=NativePinDialog159.verify(test,activity)
            main{dialog=invoke("manageAddressProfiles") as AlertDialog};settle()
            tap(dialog!!.window!!.decorView.findViewWithTag("managed_add"))
            main{
                check(!dialog!!.isShowing)
                check(all(activity.window.decorView).filterIsInstance<TextView>().none{it.text.toString()=="Нова адреса"})
                check(all(activity.window.decorView).filterIsInstance<TextView>().any{it.text.toString()=="Оберіть вашу адресу"})
            };capture("add-address")
            tap(all(activity.window.decorView).filterIsInstance<Button>().single{it.text.toString()=="Скасувати зміну"})
            main{check(OutageRepository(context).binding()==previous && AddressProfiles(context).profiles()==profiles)}
            val flow=NativeAddressTouchFlow159.verify(test,activity)
            return JSONObject().put("windows",checks).put("pin",pin).put("full_address_flow",flow).put("fontScale",context.resources.configuration.fontScale)
                .put("light",AppAppearance.light(context)).put("search_selects_exact_item",true).put("reminder_persisted",true)
                .put("no_keeps_binding",true).put("full_context_accessible",true).put("real_touch_injection",true).put("no_new_address_caption",true)
        }finally{main{dialog?.dismiss()}}
    }
}
