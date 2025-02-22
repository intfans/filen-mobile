import storage from "../../../storage"
import { StackActions } from "@react-navigation/native"
import { NavigationContainerRef } from "@react-navigation/native"
import { query } from "../../../db"

export const logout = ({ navigation }: { navigation: NavigationContainerRef<ReactNavigation.RootParamList> }) => {
    try{
        storage.delete("apiKey")
        storage.delete("userId")
        storage.delete("email"),
        storage.delete("masterKeys")
        storage.delete("authVersion")
        storage.set("isLoggedIn", false)

        query("DELETE FROM key_value").catch(console.error)

        // @ts-ignore
        if(typeof navigation.replace == "function"){
            // @ts-ignore
            navigation.replace("LoginScreen")
        }
        else{
            // @ts-ignore
            navigation.current.dispatch(StackActions.replace("LoginScreen"))
        }
    }
    catch(e){
        console.error(e)
    }
}