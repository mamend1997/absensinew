package id.absensi.ruanghadir;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;

import com.getcapacitor.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.io.OutputStream;

@CapacitorPlugin(name = "DocumentSaver")
public class DocumentSaverPlugin extends Plugin {
    @PluginMethod
    public void saveFile(PluginCall call) {
        String filename = call.getString("filename");
        String mimeType = call.getString("mimeType");
        String encodedData = call.getString("data");
        if (filename == null || filename.isEmpty() || mimeType == null || encodedData == null) {
            call.reject("Informasi file Excel tidak lengkap.");
            return;
        }

        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mimeType);
        intent.putExtra(Intent.EXTRA_TITLE, filename);
        startActivityForResult(call, intent, "handleSaveFileResult");
    }

    @ActivityCallback
    private void handleSaveFileResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            JSObject response = new JSObject();
            response.put("canceled", true);
            call.resolve(response);
            return;
        }

        Uri uri = result.getData().getData();
        if (uri == null) {
            call.reject("Lokasi penyimpanan file Excel tidak tersedia.");
            return;
        }

        String encodedData = call.getString("data");
        if (encodedData == null) {
            call.reject("Data file Excel tidak tersedia.");
            return;
        }

        try (OutputStream output = getContext().getContentResolver().openOutputStream(uri, "w")) {
            if (output == null) {
                call.reject("File Excel tidak dapat dibuka untuk ditulis.");
                return;
            }
            output.write(Base64.decode(encodedData, Base64.DEFAULT));
            JSObject response = new JSObject();
            response.put("canceled", false);
            response.put("uri", uri.toString());
            call.resolve(response);
        } catch (IOException | IllegalArgumentException | SecurityException exception) {
            call.reject("File Excel gagal disimpan.", exception);
        }
    }
}
