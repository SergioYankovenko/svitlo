package ua.svitlo.widget

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import ua.svitlo.widget.core.KYIV_ZONE
import java.time.LocalDate

/** Compatibility route for shortcuts created before the schedule moved to Home. */
class TimelineActivity:Activity(){
    override fun onCreate(savedInstanceState:Bundle?){
        super.onCreate(savedInstanceState)
        redirect(savedInstanceState?.getString("date") ?: intent.getStringExtra(EXTRA_DATE))
    }
    override fun onNewIntent(intent:Intent){
        super.onNewIntent(intent);setIntent(intent);redirect(intent.getStringExtra(EXTRA_DATE))
    }
    private fun redirect(value:String?){
        val date=runCatching{LocalDate.parse(value)}.getOrElse{LocalDate.now(KYIV_ZONE)}
        startActivity(Intent(this,MainActivity::class.java).putExtra("screen","home").putExtra("date",date.toString())
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        finish()
    }
    companion object {
        const val EXTRA_DATE="timeline_date"
        fun intent(context:Context,date:LocalDate=LocalDate.now(KYIV_ZONE))=
            Intent(context,TimelineActivity::class.java).putExtra(EXTRA_DATE,date.toString())
    }
}
