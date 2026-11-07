package ua.svitlo.widget

import android.app.Activity
import android.graphics.*
import android.content.Intent
import android.content.ClipData
import androidx.core.content.FileProvider
import ua.svitlo.widget.core.*
import java.time.LocalDate
import java.time.Instant
import java.time.Duration
import java.time.format.DateTimeFormatter
import java.io.File

object ScheduleSharing {
    private val full=DateTimeFormatter.ofPattern("dd.MM HH:mm")
    fun caption(date:LocalDate,snapshot:Snapshot,queue:String?=snapshot.queueLabel()):String {
        val plan=snapshot.plan(date)
        val status=when{date in snapshot.conflictDates->"Джерела розходяться";plan==null->"Графік ще не опубліковано"
            plan.cancelled->"ГПВ скасовано · інші відключення можливі";plan.uncertain->"Графік потребує перевірки";else->"Офіційний графік ГПВ"}
        return "Світло · ${date.format(DateTimeFormatter.ofPattern("dd.MM.yyyy"))} · підчерга ${queue ?: "—"}\n$status\n"+
            (plan?.let{"Опубліковано ${it.publishedAt.atZone(KYIV_ZONE).format(full)}\nПеревірено ${it.checkedAt.atZone(KYIV_ZONE).format(full)}\n"} ?: "")+
            "Час Києва. Графік не вимірює фактичну наявність електрики.\n${plan?.sourceUrl ?: "https://www.cherkasyoblenergo.com/off"}"
    }
    fun render(date:LocalDate,snapshot:Snapshot,now:Instant=Instant.now(),queue:String?=snapshot.queueLabel()):Bitmap {
        val tiles=HourlySchedule.tiles(date,snapshot,now)
        val rows=(tiles.size+3)/4
        val bitmap=Bitmap.createBitmap(1080,480+rows*142,Bitmap.Config.ARGB_8888)
        val canvas=Canvas(bitmap);canvas.drawColor(Color.rgb(20,37,30))
        val paint=Paint(Paint.ANTI_ALIAS_FLAG)
        fun text(value:String,x:Float,y:Float,size:Float,color:Int=Color.rgb(240,243,232)){
            paint.color=color;paint.textSize=size;paint.typeface=Typeface.create("sans-serif-medium",Typeface.NORMAL);canvas.drawText(value,x,y,paint)
        }
        val lime=Color.rgb(193,217,154)
        text("ϟ СВІТЛО",44f,68f,34f,lime)
        text("${date.format(DateTimeFormatter.ofPattern("dd.MM.yyyy"))}  ·  Підчерга ${queue ?: "—"}",44f,130f,43f)
        val plan=snapshot.plan(date)
        val status=when{date in snapshot.conflictDates->"Джерела розходяться · потрібна перевірка";plan?.uncertain==true || snapshot.feedFailed->"Збережені дані · перевірка недоступна"
            plan?.cancelled==true->"ГПВ скасовано";plan==null->"Графік ще не опубліковано";else->"Опубліковано ${plan.publishedAt.atZone(KYIV_ZONE).format(full)}"}
        text(status,44f,182f,28f)
        val track=Color.rgb(49,70,58)
        tiles.forEachIndexed{index,tile->
            val x=44f+(index%4)*252;val y=218f+(index/4)*142
            val bounds=RectF(x,y,x+234,y+122)
            paint.color=track;canvas.drawRoundRect(bounds,18f,18f,paint)
            val clip=canvas.save();val path=Path().apply{addRoundRect(bounds,18f,18f,Path.Direction.CW)};canvas.clipPath(path)
            val seconds=Duration.between(tile.start,tile.end).seconds.toFloat()
            tile.segments.forEach{segment->
                val left=x+234*Duration.between(tile.start,segment.start).seconds/seconds
                val right=x+234*Duration.between(tile.start,segment.end).seconds/seconds
                paint.color=when(segment.category){Category.SCHEDULE->Color.rgb(217,167,70);Category.PLANNED->Color.rgb(173,156,209);Category.EMERGENCY->Color.rgb(223,130,114);null->track}
                canvas.drawRect(left,y,right,y+122,paint)
                if(segment.uncertain){
                    val saved=canvas.save();canvas.clipRect(left,y,right,y+122);paint.color=Color.argb(65,240,243,232);paint.strokeWidth=2f
                    var dx=left-122;while(dx<right){canvas.drawLine(dx,y+122,dx+122,y,paint);dx+=16};canvas.restoreToCount(saved)
                }
            }
            canvas.restoreToCount(clip)
            paint.color=Color.argb(230,20,37,30);canvas.drawRoundRect(RectF(x+40,y+34,x+194,y+88),10f,10f,paint)
            text(tile.label,x+60,y+72,32f)
        }
        val footer=218f+rows*142
        text("Жовтий — ГПВ · фіолетовий — планові · червоний — аварії",44f,footer+24,27f,lime)
        text("Штрихування — невідомі або неперевірені проміжки",44f,footer+67,27f)
        text("Перевірено: ${plan?.checkedAt?.atZone(KYIV_ZONE)?.format(full) ?: "немає даних"} · час Києва",44f,footer+110,25f)
        text("Джерело: Черкасиобленерго · cherkasyoblenergo.com",44f,footer+150,25f)
        text("Графік не гарантує фактичної наявності електрики.",44f,footer+190,25f)
        return bitmap
    }
    fun share(activity:Activity,date:LocalDate,snapshot:Snapshot,queue:String?=snapshot.queueLabel()){
        val folder=File(activity.cacheDir,"shared").apply{mkdirs()}
        val file=File(folder,"svitlo-schedule.png")
        val bitmap=render(date,snapshot,queue=queue)
        try{file.outputStream().use{bitmap.compress(Bitmap.CompressFormat.PNG,100,it)}}finally{bitmap.recycle()}
        val uri=FileProvider.getUriForFile(activity,activity.packageName+".files",file)
        val intent=Intent(Intent.ACTION_SEND).setType("image/png").putExtra(Intent.EXTRA_STREAM,uri).putExtra(Intent.EXTRA_TEXT,caption(date,snapshot,queue))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION).apply{clipData=ClipData.newRawUri("Графік Світло",uri)}
        activity.startActivity(Intent.createChooser(intent,"Поділитися графіком"))
    }
}
