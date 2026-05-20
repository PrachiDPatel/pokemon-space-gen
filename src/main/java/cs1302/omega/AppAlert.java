package cs1302.omega;

import javafx.scene.control.Alert;
import javafx.scene.control.Alert.AlertType;
import javafx.scene.control.TextArea;

/** This class makes an allert for bad inputs.
 */
public class AppAlert {

    /** This method makes an alertdialog for input errors.
     */
    public static void alerter() {

        Alert a = new Alert(AlertType.ERROR);
        TextArea message = new TextArea("\t\t\t\t!!MAKE SURE THE INPUT IS VALID!!\n\nThis means "
            + "that the date must be formatted as follows:\n\n\t\t\t\t(YEAR-MONTH-DAY,"
            + " in 0000-00-00 form)"
            + "\n\t\t\t\t\tFor example: 2004-01-31\n\nNOTE: Only dates after 1995-06-16 "
            + "and before today's date are valid\nbecause these are the only dates"
            + " that currently have an APOD!");

        message.setEditable(false);
        a.getDialogPane().setContent(message);
        a.showAndWait();

    } //alert

}
