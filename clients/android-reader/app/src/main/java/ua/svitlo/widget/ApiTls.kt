package ua.svitlo.widget

import android.content.Context
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManager
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * Completes the operator's incomplete certificate chain without adding trust anchors.
 * Apply this factory only to the fixed cabinet.cherkasyoblenergo.com API connection.
 * HttpsURLConnection's default hostname verifier must remain enabled.
 */
object ApiTls {
    @Volatile private var cached: SSLSocketFactory? = null

    fun socketFactory(context: Context): SSLSocketFactory = cached ?: synchronized(this) {
        cached ?: create(context.applicationContext).also { cached = it }
    }

    private fun create(context: Context): SSLSocketFactory {
        val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        factory.init(null as KeyStore?)
        val system = factory.trustManagers.filterIsInstance<X509TrustManager>().single()
        val certificateFactory = CertificateFactory.getInstance("X.509")
        val intermediates = listOf(R.raw.sectigo_dv_r36, R.raw.sectigo_r46_usertrust).map { resource ->
            context.resources.openRawResource(resource).use {
                certificateFactory.generateCertificate(it) as X509Certificate
            }
        }
        val completing = object : X509TrustManager {
            override fun getAcceptedIssuers(): Array<X509Certificate> = system.acceptedIssuers

            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
                system.checkClientTrusted(chain, authType)
            }

            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                // Prefer the server's own chain, including after it has been repaired/rotated.
                val originalFailure = try {
                    system.checkServerTrusted(chain, authType)
                    return
                } catch (failure: CertificateException) {
                    failure
                }
                if (chain.isEmpty()) throw originalFailure
                val completed = chain.toMutableList()
                for (candidate in intermediates) {
                    val last = completed.last()
                    if (last.issuerX500Principal == candidate.subjectX500Principal && candidate !in completed) {
                        try {
                            candidate.checkValidity()
                            last.verify(candidate.publicKey)
                        } catch (invalid: GeneralSecurityException) {
                            throw originalFailure
                        }
                        completed += candidate
                    }
                }
                if (completed.size == chain.size) throw originalFailure
                // Only Android's existing system roots are trusted. Bundled certificates are
                // untrusted chain-building material, never imported into a trusted KeyStore.
                system.checkServerTrusted(completed.toTypedArray(), authType)
            }
        }
        return SSLContext.getInstance("TLS").apply {
            init(null, arrayOf<TrustManager>(completing), null)
        }.socketFactory
    }
}
