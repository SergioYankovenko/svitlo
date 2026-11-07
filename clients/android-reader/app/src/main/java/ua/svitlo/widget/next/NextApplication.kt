package ua.svitlo.widget.next

import android.app.Application
import android.content.res.Configuration

/** No legacy repository, migration, worker or widget refresh is entered by this package. */
class NextApplication:Application(){
    override fun onConfigurationChanged(newConfig:Configuration){super.onConfigurationChanged(newConfig);NextWidgets.update(this)}
}
