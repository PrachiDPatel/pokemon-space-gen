package cs1302.omega;

import javafx.scene.layout.VBox;
import javafx.scene.layout.Priority;
import javafx.scene.control.Button;
import javafx.scene.control.TextInputDialog;
import javafx.scene.control.TextField;
import javafx.scene.control.Label;
import javafx.scene.control.ComboBox;
import javafx.scene.control.Separator;


/** This class creates the Components.
 */
public class Components {

    /**
     * This method creates the components for the App class.
     *
     * @return HBox object.
     */
    public static VBox create() {

        VBox controlBar = new VBox(10);
        Button play = new Button("\t\t\t\t\t  Click Here to enter "
            + "another date and get another pokemon!!!\t\t\t\t\t  ");

        // Adding the components to the HBox
        controlBar.getChildren().addAll(play);

        return controlBar;
    } // controlBar

} // Components
