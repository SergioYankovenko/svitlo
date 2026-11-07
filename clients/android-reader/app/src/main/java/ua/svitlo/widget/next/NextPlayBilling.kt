package ua.svitlo.widget.next

import android.app.Activity
import android.app.AlertDialog
import com.android.billingclient.api.*
import org.json.JSONObject

/** Play's client reports a purchase. Only the server can grant and acknowledge it. */
internal class NextPlayBilling(
    private val host:Activity, private val repo:NextRepository, private val async:((()->Unit)->Unit),
    private val ui:((()->Unit)->Unit), private val message:(String)->Unit, private val changed:()->Unit
){
    private data class Checkout(val owner:String,val account:String,val products:Set<String>)
    private var scope:Checkout?=null
    private var closed=false
    private var busy=false
    private val client=BillingClient.newBuilder(host)
        .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
        .enableAutoServiceReconnection()
        .setListener{result,purchases ->
            if(result.responseCode==BillingClient.BillingResponseCode.OK)accept(purchases.orEmpty())
            else if(result.responseCode==BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED)restore()
            else if(result.responseCode!=BillingClient.BillingResponseCode.USER_CANCELED)ui{message("Не вдалося завершити дію в Google Play")}
        }.build()

    fun open(restore:Boolean=false){
        if(busy||closed||host.isFinishing)return
        busy=true
        async{
            try{
                val owner=repo.api.vault.read("subject")?:throw IllegalStateException()
                val packet=repo.api.billing("checkout",owner=owner)
                val obfuscated=packet.getString("obfuscatedAccountId")
                val products=packet.getJSONArray("productIds").let{arr->(0 until arr.length()).map{arr.getString(it)}.toSet()}
                check(packet.getString("packageName")==host.packageName&&products.isNotEmpty()&&products.size<=12&&Regex("[A-Za-z0-9_-]{1,64}").matches(obfuscated))
                ui{
                    if(closed)return@ui
                    scope=Checkout(owner,obfuscated,products)
                    connect{if(restore)restore()else offer()}
                }
            }catch(_:Exception){ui{busy=false;message("Підписка поки недоступна. Перевірте вхід до акаунта")}}
        }
    }
    private fun connect(ready:()->Unit){
        if(client.isReady){ready();return}
        client.startConnection(object:BillingClientStateListener{
            override fun onBillingServiceDisconnected(){ui{busy=false}}
            override fun onBillingSetupFinished(result:BillingResult){ui{
                if(closed)return@ui
                if(result.responseCode==BillingClient.BillingResponseCode.OK)ready() else{busy=false;message("Google Play поки недоступний")}
            }}
        })
    }
    private fun offer(){
        val checkout=scope?:return
        val products=checkout.products.map { QueryProductDetailsParams.Product.newBuilder().setProductType(BillingClient.ProductType.SUBS).setProductId(it).build() }
        client.queryProductDetailsAsync(QueryProductDetailsParams.newBuilder().setProductList(products).build()){result,details ->
            ui{
                busy=false
                if(closed||checkout!==scope||checkout.owner!=repo.api.vault.read("subject"))return@ui
                val offers=details.productDetailsList.filter{it.productId in checkout.products}.flatMap{p->p.subscriptionOfferDetails.orEmpty().map{o->p to o}}.take(12)
                if(result.responseCode!=BillingClient.BillingResponseCode.OK||offers.isEmpty()){message("Немає доступних планів підписки");return@ui}
                val items=offers.map{(p,o)->p.title+" · "+o.pricingPhases.pricingPhaseList.joinToString(" → "){it.formattedPrice}}.toTypedArray()
                AlertDialog.Builder(host).setTitle("Підписка Google Play").setItems(items){_,position ->
                    if(closed||checkout!==scope||checkout.owner!=repo.api.vault.read("subject"))return@setItems
                    val (p,o)=offers[position]
                    val selection=BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(p).setOfferToken(o.offerToken).build()
                    val flow=BillingFlowParams.newBuilder().setProductDetailsParamsList(listOf(selection)).setObfuscatedAccountId(checkout.account).build()
                    if(client.launchBillingFlow(host,flow).responseCode!=BillingClient.BillingResponseCode.OK)message("Не вдалося відкрити Google Play")
                }.setNegativeButton("Скасувати",null).show()
            }
        }
    }
    fun refreshOnResume(){if(!closed&&client.isReady&&scope!=null&&!busy)restore(silent=true)}
    private fun restore(silent:Boolean=false){
        if(closed||scope==null)return
        client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).build()){result,purchases->
            ui{busy=false;if(!closed){if(result.responseCode==BillingClient.BillingResponseCode.OK)accept(purchases,silent)else if(!silent)message("Не вдалося оновити підписку")}}
        }
    }
    private fun accept(purchases:List<Purchase>,silent:Boolean=false){
        val checkout=scope?:return
        val matching=purchases.filter{it.accountIdentifiers?.obfuscatedAccountId==checkout.account&&it.products.any(checkout.products::contains)}.take(12)
        if(matching.isEmpty()){if(!silent)ui{message("Для цього акаунта немає покупок")};return}
        async{
            try{
                var checked=false
                for(p in matching.filter{it.purchaseState==Purchase.PurchaseState.PURCHASED}){
                    val id=p.products.first(checkout.products::contains)
                    val result=repo.api.billing("verify",JSONObject().put("productId",id).put("purchaseToken",p.purchaseToken),checkout.owner)
                    check(result.optString("state")=="pending_verification");checked=true
                }
                repo.ownerSubscription()
                ui{if(!silent)message(if(checked)"Підписка перевіряється"else"Очікуємо підтвердження Google Play");changed()}
            }catch(_:Exception){if(!silent)ui{message("Не вдалося перевірити підписку. Спробуйте відновити покупки")}}
        }
    }
    fun close(){closed=true;scope=null;client.endConnection()}
}
