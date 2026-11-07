package ua.svitlo.widget.next

import android.app.Activity
import android.os.CancellationSignal
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import org.json.JSONObject

internal class NextGoogleAccount(
    private val host:Activity, private val repo:NextRepository, private val async:((()->Unit)->Unit),
    private val ui:((()->Unit)->Unit), private val message:(String)->Unit, private val changed:()->Unit
){
    private var cancellation:CancellationSignal?=null
    private var busy=false
    fun open(restore:Boolean){
        if(busy||host.isFinishing)return
        if(restore&&(repo.profiles().isNotEmpty()||repo.memberships().isNotEmpty())){message("Для відновлення на цьому пристрої потрібен окремий вхід");return}
        busy=true
        async{
            try{
                val status=repo.api.identity("status")
                check(status.optBoolean("configured"))
                val owner=status.getJSONObject("account").getString("accountId")
                val challenge=repo.api.identity("challenge",JSONObject().put("mode",if(restore)"sign_in"else"link"),owner)
                val nonce=challenge.getString("nonce")
                val client=challenge.getString("serverClientId")
                require(Regex("[A-Za-z0-9_-]{43}").matches(nonce)&&Regex("[A-Za-z0-9._-]+\\.apps\\.googleusercontent\\.com").matches(client))
                ui{request(client,nonce,owner,restore)}
            }catch(_:Exception){ui{busy=false;message("Вхід через Google поки недоступний")}}
        }
    }
    private fun request(client:String,nonce:String,owner:String,restore:Boolean){
        val request=GetCredentialRequest.Builder().addCredentialOption(GetSignInWithGoogleOption.Builder(client).setNonce(nonce).build()).build()
        val signal=CancellationSignal();cancellation=signal
        CredentialManager.create(host).getCredentialAsync(host,request,signal,host.mainExecutor,object:CredentialManagerCallback<GetCredentialResponse,GetCredentialException>{
            override fun onError(e:GetCredentialException){cancellation=null;busy=false;if(e !is GetCredentialCancellationException&&!host.isFinishing)message("Не вдалося увійти через Google")}
            override fun onResult(response:GetCredentialResponse){
                cancellation=null
                val token=runCatching {
                    val credential=response.credential
                    require(credential is CustomCredential&&credential.type==GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL)
                    GoogleIdTokenCredential.createFrom(credential.data).idToken
                }.getOrNull()
                if(token==null){busy=false;message("Не вдалося увійти через Google");return}
                async{
                    try{
                        val result=repo.api.identity("complete",JSONObject().put("nonce",nonce).put("idToken",token),owner)
                        if(result.optString("state")=="confirmation_required"){
                            ui{busy=false;message("На цьому пристрої вже є дані іншого акаунта")};return@async
                        }
                        check(result.optString("state")=="authenticated")
                        if(!restore)check(result.getJSONObject("account").getString("accountId")==owner)
                        val synced=runCatching{repo.synchronizeAccountHomes()}.isSuccess
                        ui{busy=false;message(if(synced)"Акаунт підключено"else"Ви увійшли. Адреси поки не оновилися");changed()}
                    }catch(_:Exception){ui{busy=false;message("Не вдалося підтвердити вхід")}}
                }
            }
        })
    }
    fun close(){cancellation?.cancel();cancellation=null}
}
