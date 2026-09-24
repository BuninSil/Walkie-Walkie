package ru.radio.walkie;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

/*
 * Итог установки обновления от PackageInstaller и «приложение обновилось» (MY_PACKAGE_REPLACED).
 */
public class UpdateReceiver extends BroadcastReceiver {

    static final String ACTION_STATUS = "ru.radio.walkie.UPDATE_STATUS";

    @Override
    @SuppressWarnings("deprecation")
    public void onReceive(Context context, Intent intent) {
        Updater u = Updater.get(context);
        if (ACTION_STATUS.equals(intent.getAction())) {
            int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
            u.installResult(status, intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE),
                intent.getParcelableExtra(Intent.EXTRA_INTENT));
        } else if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) {
            Intent open = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                context.startActivity(open); // можно, если у приложения есть «поверх других приложений»
            } catch (RuntimeException ignored) {
                // Android не дал открыть из фона — остаётся уведомление
            }
            u.notifyUser(context.getApplicationInfo().loadLabel(context.getPackageManager()) + " обновлена до " + BuildConfig.VERSION_NAME,
                "Нажмите, чтобы открыть", open);
        }
    }
}
