package ua.svitlo.widget.next

import android.Manifest
import android.app.AlertDialog
import android.content.pm.PackageManager
import android.graphics.*
import android.os.*
import android.text.*
import android.view.*
import android.widget.*
import com.google.zxing.*
import com.google.zxing.common.HybridBinarizer
import ua.svitlo.widget.AppDialogPanel
import java.util.WeakHashMap
import java.util.concurrent.Executors

/** Camera and QR material belong to a window, never to a background worker. */
internal object SensorWindows {
    private val dialogs=WeakHashMap<NextActivity,MutableSet<AlertDialog>>()
    private val secrets=WeakHashMap<NextActivity,MutableSet<AlertDialog>>()
    private val scanners=WeakHashMap<NextActivity,NativeSensorScanner>()
    fun register(a:NextActivity,d:AlertDialog){dialogs.getOrPut(a){mutableSetOf()}.apply{removeAll{!it.isShowing};add(d)}}
    fun sensitive(a:NextActivity,d:AlertDialog){secrets.getOrPut(a){mutableSetOf()}.add(d)}
    fun scanner(a:NextActivity,s:NativeSensorScanner){scanners.put(a,s)?.close()}
    fun remove(a:NextActivity,s:NativeSensorScanner){if(scanners[a]===s)scanners.remove(a)}
    fun pause(a:NextActivity){scanners[a]?.pause();secrets.remove(a)?.toList()?.forEach{it.dismiss()}}
    fun permission(a:NextActivity,granted:Boolean){scanners[a]?.permissionResult(granted)}
    fun close(a:NextActivity){scanners.remove(a)?.close();dialogs.remove(a)?.toList()?.forEach{it.dismiss()};secrets.remove(a)}
}

/** UI246 camera/manual states with the live BE-06 QR parser instead of DEMO codes. */
@Suppress("DEPRECATION")
internal class NativeSensorScanner(private val a:NextActivity,private val u:NextUi,private val address:String,private val checked:(String,NativeSensorScanner)->Unit):SurfaceHolder.Callback,android.hardware.Camera.PreviewCallback {
    private var camera:android.hardware.Camera?=null
    private lateinit var dialog:AlertDialog
    private lateinit var cameraBox:FrameLayout
    private lateinit var manual:LinearLayout
    private lateinit var surface:SurfaceView
    private lateinit var input:EditText
    private lateinit var status:TextView
    private lateinit var check:Button
    private lateinit var modes:LinearLayout
    private var busy=false
    private var code:String?=null
    private var mode="camera"
    @Volatile private var disposed=false
    private var requested=false
    private var surfaceReady=false
    private var epoch=0
    private var decoding=false
    private var lastFrame=0L
    private val main=Handler(Looper.getMainLooper())
    private val decoder=Executors.newSingleThreadExecutor()
    fun show(){
        SensorWindows.scanner(a,this)
        val panel=AppDialogPanel(a,"Підключити датчик",address,prefix="sensor_scanner")
        val col=u.column()
        cameraBox=FrameLayout(a).apply{setBackgroundColor(Color.BLACK);layoutParams=LinearLayout.LayoutParams(-1,u.dp(200))}
        surface=SurfaceView(a).apply{contentDescription="Камера для сканування QR";holder.addCallback(this@NativeSensorScanner)}
        cameraBox.addView(surface,FrameLayout.LayoutParams(-1,-1))
        cameraBox.addView(object:View(a){override fun onDraw(c:Canvas){val p=Paint(Paint.ANTI_ALIAS_FLAG).apply{color=u.p.accent;style=Paint.Style.STROKE;strokeWidth=u.dp(2).toFloat()};val size=minOf(width,height)*.72f;c.drawRoundRect((width-size)/2,(height-size)/2,(width+size)/2,(height+size)/2,u.dp(12).toFloat(),u.dp(12).toFloat(),p)}},FrameLayout.LayoutParams(-1,-1))
        u.add(col,cameraBox,0)
        manual=u.column().apply{visibility=View.GONE}
        u.add(manual,u.text("Код датчика",14f),0)
        input=panel.input("Код датчика","sensor_code").apply{filters=arrayOf(InputFilter.LengthFilter(512));inputType=android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS;importantForAutofill=View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS}
        u.add(manual,input,6)
        u.add(manual,u.button("Сканувати QR"){start()},8)
        u.add(col,manual,0)
        status=u.text("Дозволь доступ до камери, щоб сканувати QR.",14f).apply{accessibilityLiveRegion=View.ACCESSIBILITY_LIVE_REGION_POLITE};u.add(col,status,10)
        modes=u.row(u.button("Ввести код"){if(!busy){stop();code=null;mode="manual";check.isEnabled=false;cameraBox.visibility=View.GONE;manual.visibility=View.VISIBLE;input.setText("");status.text="Введи код датчика.";input.requestFocus()}},u.button("Сканувати ще"){start()})
        u.add(col,modes,8)
        panel.setBody(col)
        check=panel.button("Перевірити","sensor_check").apply{gravity=Gravity.CENTER;isEnabled=false;setOnClickListener{if(busy)return@setOnClickListener;val raw=if(mode=="manual")input.text.toString().trim()else code.orEmpty();if(runCatching{SensorPolicy.qr(raw)}.isFailure){status.text="Цей QR не підходить. Наведи камеру на код датчика.";return@setOnClickListener};busy=true;stop();setControls(false);status.text="Підключення";checked(raw,this@NativeSensorScanner)}}
        panel.footer(listOf(panel.button("Скасувати","sensor_scan_cancel",cancel=true).apply{gravity=Gravity.CENTER;setOnClickListener{dialog.dismiss()}},check),horizontal=a.resources.configuration.fontScale<1.5f)
        input.addTextChangedListener(object:TextWatcher{override fun beforeTextChanged(s:CharSequence?,start:Int,count:Int,after:Int){};override fun onTextChanged(s:CharSequence?,start:Int,before:Int,count:Int){if(mode=="manual"){code=null;check.isEnabled=!busy&&!s.isNullOrBlank()}};override fun afterTextChanged(s:Editable?) {}})
        dialog=panel.show();dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE);SensorWindows.register(a,dialog)
        dialog.setOnDismissListener{dispose()};start()
    }
    private fun start(){
        if(disposed||busy)return
        stop();code=null;mode="camera";input.setText("");check.isEnabled=false;manual.visibility=View.GONE;cameraBox.visibility=View.VISIBLE
        if(a.checkSelfPermission(Manifest.permission.CAMERA)!=PackageManager.PERMISSION_GRANTED){requested=true;status.text="Дозволь доступ до камери, щоб сканувати QR.";a.requestPermissions(arrayOf(Manifest.permission.CAMERA),941);return}
        requested=true
        if(surfaceReady)open()
    }
    fun permissionResult(granted:Boolean){if(disposed)return;if(granted){requested=true;if(surfaceReady)open()}else{requested=false;status.text="Доступ до камери не надано. Введи код або дозволь камеру в налаштуваннях."}}
    private fun open(){
        if(disposed||busy||!requested||!surfaceReady||mode!="camera"||code!=null||camera!=null)return
        try{
            val back=(0 until android.hardware.Camera.getNumberOfCameras()).firstOrNull{val info=android.hardware.Camera.CameraInfo();android.hardware.Camera.getCameraInfo(it,info);info.facing==android.hardware.Camera.CameraInfo.CAMERA_FACING_BACK} ?:error("camera")
            camera=android.hardware.Camera.open(back).also{cam->
                val params=cam.parameters;params.supportedPreviewSizes.minByOrNull{kotlin.math.abs(it.width-640)+kotlin.math.abs(it.height-480)}?.let{params.setPreviewSize(it.width,it.height)}
                if(params.supportedFocusModes.contains(android.hardware.Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE))params.focusMode=android.hardware.Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE
                params.previewFormat=ImageFormat.NV21;cam.parameters=params
                val info=android.hardware.Camera.CameraInfo();android.hardware.Camera.getCameraInfo(back,info)
                val rotation=when(a.windowManager.defaultDisplay.rotation){Surface.ROTATION_90->90;Surface.ROTATION_180->180;Surface.ROTATION_270->270;else->0}
                cam.setDisplayOrientation((info.orientation-rotation+360)%360);cam.setPreviewDisplay(surface.holder);cam.setPreviewCallback(this);cam.startPreview()
            }
            status.text="Наведи камеру на QR-код датчика."
        }catch(_:Exception){stop();status.text="Камера недоступна або зайнята. Спробуй ще чи введи код."}
    }
    private fun stop(){epoch++;requested=false;camera?.let{runCatching{it.setPreviewCallback(null);it.stopPreview()};runCatching{it.release()}};camera=null}
    fun pause(){stop();if(!disposed&&mode=="camera"&&code==null)status.text="Камеру призупинено. Натисни «Сканувати ще»."}
    val isOpen get()=!disposed&&::dialog.isInitialized&&dialog.isShowing
    val maySubmit get()=!disposed
    fun result(message:String){if(!isOpen)return;busy=false;status.text=message;setControls(true)}
    private fun setControls(enabled:Boolean){input.isEnabled=enabled;for(i in 0 until modes.childCount)modes.getChildAt(i).isEnabled=enabled;check.isEnabled=enabled&&(if(mode=="manual")input.text.isNotBlank()else code!=null)}
    fun close(){if(::dialog.isInitialized&&dialog.isShowing)dialog.dismiss()else dispose()}
    private fun dispose(){if(disposed)return;disposed=true;stop();code=null;if(::input.isInitialized)input.setText("");main.removeCallbacksAndMessages(null);decoder.shutdownNow();SensorWindows.remove(a,this)}
    override fun surfaceCreated(holder:SurfaceHolder){surfaceReady=true;open()}
    override fun surfaceChanged(holder:SurfaceHolder,format:Int,width:Int,height:Int){}
    override fun surfaceDestroyed(holder:SurfaceHolder){surfaceReady=false;stop()}
    override fun onPreviewFrame(data:ByteArray?,cam:android.hardware.Camera?){
        if(data==null||cam==null||disposed||decoding||code!=null||SystemClock.elapsedRealtime()-lastFrame<300)return
        decoding=true;lastFrame=SystemClock.elapsedRealtime();val token=epoch;val size=cam.parameters.previewSize;val bytes=data.copyOf()
        decoder.submit{
            val raw=runCatching{val source=PlanarYUVLuminanceSource(bytes,size.width,size.height,0,0,size.width,size.height,false);MultiFormatReader().decode(BinaryBitmap(HybridBinarizer(source)),mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),DecodeHintType.TRY_HARDER to true)).text}.getOrNull();bytes.fill(0)
            main.post{decoding=false;if(disposed||token!=epoch||raw==null)return@post;if(runCatching{SensorPolicy.qr(raw)}.isSuccess){code=raw;input.setText(raw);check.isEnabled=true;stop();status.text="Код зчитано. Натисни «Перевірити»."}else status.text="Цей QR не підходить. Наведи камеру на код датчика."}
        }
    }
}
