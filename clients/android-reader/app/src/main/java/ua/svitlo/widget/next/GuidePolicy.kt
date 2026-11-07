package ua.svitlo.widget.next

import java.time.LocalDate
import kotlin.math.*

/** REF-01 / UI189 pure policy, transcribed from the approved tour.js. */
internal object GuidePolicy {
    data class Box(val left:Double,val top:Double,val right:Double,val bottom:Double){val height get()=bottom-top}
    data class Aim(val side:String,val pose:String,val shift:Double,val offset:Double,val hits:Boolean,val angle:Double,val score:Double)
    private data class Pose(val id:String,val x:Double,val y:Double,val dx:Double,val dy:Double)
    private val poses=listOf(Pose("up-left",.164,.28,-1.0,-.95),Pose("up-right",.8,.27,1.0,-1.05),Pose("down-left",.166,.67,-1.0,.95),Pose("down-right",.81,.70,1.0,1.05),Pose("up",.28,.215,-.05,-1.0),Pose("down",.717,.65,.02,1.0))
    fun pointing(target:Box,panel:Box,width:Double,height:Double):Aim {
        val corners=listOf(target.left,(target.left+target.right)/2,target.right).flatMap{x->listOf(target.top,(target.top+target.bottom)/2,target.bottom).map{y->x to y}}
        var best:Aim?=null
        for(side in listOf("right","left"))for(pose in poses)for(shift in if(pose.id=="up")listOf(0.0,12.0)else listOf(0.0)){
            val x=(if(side=="right")panel.right-width else panel.left)+shift
            val localX=(pose.x*1.35-.175)*width;val localY=(pose.y*1.35-.1)*width;val maximum=max(0.0,panel.height-height)
            val offsets=listOf(0.0,maximum/2,maximum)+corners.map{(cx,cy)->(cy-pose.dy/pose.dx*(cx-x-localX)-localY-panel.top).coerceIn(0.0,maximum)}
            for(offset in offsets){
                val tx=x+localX;val ty=panel.top+offset+localY
                var enter=0.0;var leave=Double.POSITIVE_INFINITY
                for((low,high,tip,ray)in listOf(listOf(target.left,target.right,tx,pose.dx),listOf(target.top,target.bottom,ty,pose.dy))){val a=(low-tip)/ray;val b=(high-tip)/ray;enter=max(enter,min(a,b));leave=min(leave,max(a,b))}
                val hits=leave>=enter
                val angle=if(hits)0.0 else corners.minOf{(cx,cy)->val dx=cx-tx;val dy=cy-ty;acos(((dx*pose.dx+dy*pose.dy)/hypot(dx,dy)/hypot(pose.dx,pose.dy)).coerceIn(-1.0,1.0))*180/PI}
                val distance=hypot(tx-(target.left+target.right)/2,ty-(target.top+target.bottom)/2)
                val score=angle*100+(if(side=="left").5 else 0.0)+shift*.001+distance*.0001+(maximum-offset)*.0001
                if(best==null||score<best.score)best=Aim(side,pose.id,shift,offset,hits,angle,score)
            }
        }
        return requireNotNull(best)
    }
    fun activeDays(days:List<LocalDate>,date:LocalDate)=(days+date).distinct().takeLast(3)
    fun supportEligible(days:List<LocalDate>,clicked:Boolean,seen:Boolean,home:Boolean,visible:Boolean,blocked:Boolean)=days.distinct().size>=3&&!clicked&&!seen&&home&&visible&&!blocked
}
